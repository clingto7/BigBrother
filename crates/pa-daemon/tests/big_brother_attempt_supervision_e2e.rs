//! Attempt-supervision e2e (ADR 0028): a stalled review attempt is
//! cancelled and retried as a fresh attempt that completes, and a range
//! that exhausts its attempt ceiling fails loudly — the cursor holds, a
//! later range from the same base re-covers the failed commits and
//! completes. Real daemon, real observer binary, mock provider.
//!
//! Run with a short TMPDIR (`TMPDIR=/tmp/bbtest/`): the daemon's Unix
//! socket path must stay under `SUN_LEN` on macOS.
// Stack-resident futures by design on the daemon's hot paths.
#![allow(clippy::large_futures)]
// Narrowing casts sit at OS boundaries where the kernel bounds the values.
#![allow(
    clippy::cast_possible_truncation,
    clippy::cast_possible_wrap,
    clippy::cast_sign_loss,
    clippy::cast_precision_loss
)]
// Style gate only, not correctness.
#![allow(clippy::too_many_lines)]
// API-shape opinions, not defects; the surfaces are deliberate.
#![allow(
    clippy::unnecessary_wraps,
    clippy::zero_sized_map_values,
    clippy::struct_excessive_bools,
    clippy::struct_field_names
)]
#![cfg(unix)]

use std::fmt::Write as _;
use std::io::{BufRead, BufReader, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Output, Stdio};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use serde_json::{json, Value};

use pa_daemon::big_brother::init::{run_init, InitOptions};
use pa_daemon::big_brother::query::{load_repository_status, render_status, QueryOptions};
use pa_daemon::big_brother::state::RepositoryStateStore;

/// One attempt's budget in every profile here: generous enough for the
/// retry's full cold-wake chain (worker spawn, dispatch turn, child
/// turns, synthesis) on a debug build. The stall itself is triggered by
/// [`age_out_attempt`] rewinding the attempt stamp, not by waiting the
/// budget out.
const ATTEMPT_TIMEOUT_SECONDS: u32 = 60;

struct Daemon {
    child: Child,
    #[allow(dead_code)]
    socket: PathBuf,
}

#[derive(Clone, Copy)]
enum ReviewMockBehavior {
    StallThenReply,
    RuntimeMissingThenReply,
}

impl Drop for Daemon {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

fn chunk(delta: &Value, finish_reason: Option<&str>) -> String {
    json!({
        "id": "chatcmpl-attempt",
        "object": "chat.completion.chunk",
        "created": 1_750_000_000,
        "model": "mock-1",
        "choices": [{"index": 0, "delta": delta, "finish_reason": finish_reason}],
    })
    .to_string()
}

/// The review provider mock, content-driven (the handoff's discipline: a
/// mis-keyed discriminator script re-dispatches forever). The conductor
/// (model `main`) dispatches while the history carries fewer full
/// dispatch rounds for the CURRENT range than the wake history requires
/// (one per `REVIEW_RANGE` plus one per `Retry attempt` note); the
/// `project-fit` either stalls by hanging the connection or emits the
/// packaged-runtime failure on its first call, then answers on retry;
/// every other layer model answers once.
fn serve_review(
    mut stream: TcpStream,
    project_fit_calls: &AtomicUsize,
    behavior: ReviewMockBehavior,
) -> std::io::Result<()> {
    let mut reader = BufReader::new(stream.try_clone()?);
    let mut content_length = 0usize;
    loop {
        let mut line = String::new();
        if reader.read_line(&mut line)? == 0 {
            return Ok(());
        }
        if line == "\r\n" {
            break;
        }
        if let Some(value) = line.to_ascii_lowercase().strip_prefix("content-length:") {
            content_length = value.trim().parse().unwrap_or_default();
        }
    }
    let mut body = vec![0; content_length];
    reader.read_exact(&mut body)?;
    let request: Value = serde_json::from_slice(&body).map_err(std::io::Error::other)?;
    let model = request["model"].as_str().unwrap_or_default();
    // Verdicts read the MESSAGES, never the serialized request: a
    // message row repeats its text into preview fields, so counting on
    // the serialized whole over-counts (the first version of this mock
    // re-dispatched forever off exactly that).
    let messages = request["messages"].as_array().cloned().unwrap_or_default();
    let message_text = |message: &Value| -> String {
        match message.get("content") {
            Some(Value::String(text)) => text.clone(),
            Some(Value::Array(blocks)) => blocks
                .iter()
                .filter_map(|block| block.get("text").and_then(Value::as_str))
                .collect::<Vec<_>>()
                .join("\n"),
            _ => String::new(),
        }
    };
    let retry_notes = messages
        .iter()
        .filter(|message| message_text(message).contains("Retry attempt"))
        .count();
    let request_text = request.to_string();
    let range = || -> Option<(String, String)> {
        let (base, head) = request_text
            .rsplit_once("REVIEW_RANGE ")
            .and_then(|(_, suffix)| suffix.split_once(" END"))
            .and_then(|(range, _)| range.split_once(".."))?;
        if base.starts_with('<') {
            return None;
        }
        Some((base.to_string(), head.to_string()))
    }();
    let data = if model == "main" {
        // Dispatch rounds counted off the assistant history's tool_calls
        // blocks — the one place the wire never duplicates (custom rows
        // repeat their text into preview fields, and how often depends on
        // the row kind) — and scoped to the CURRENT range: a later range's
        // wake replays the conductor transcript, whose history still
        // carries the earlier range's dispatch calls. A retry note raises
        // the requirement by ONE round however many rows carry its text.
        let dispatch_target = range.filter(|(base, head)| {
            let dispatch_calls_seen: usize = messages
                .iter()
                .filter_map(|message| message.get("tool_calls").and_then(Value::as_array))
                .flatten()
                .filter(|call| {
                    call.get("function").is_some_and(|function| {
                        function.get("name").and_then(Value::as_str) == Some("dispatch_review")
                            && function
                                .get("arguments")
                                .and_then(Value::as_str)
                                .and_then(|text| serde_json::from_str::<Value>(text).ok())
                                .is_some_and(|args| {
                                    args.get("baseSha").and_then(Value::as_str)
                                        == Some(base.as_str())
                                        && args.get("headSha").and_then(Value::as_str)
                                            == Some(head.as_str())
                                })
                    })
                })
                .count();
            let required_calls = 3 * (1 + retry_notes.min(1));
            dispatch_calls_seen < required_calls
        });
        match dispatch_target {
            Some((base, head)) => {
                let layers = ["requirements", "project-fit", "implementation"];
                let calls: Vec<Value> = layers
                    .iter()
                    .enumerate()
                    .map(|(index, layer)| {
                        json!({
                            "index": index,
                            "id": format!("call-review-{index}-{head}"),
                            "type": "function",
                            "function": {
                                "name": "dispatch_review",
                                "arguments": json!({
                                    "layer": layer,
                                    "baseSha": base,
                                    "headSha": head
                                }).to_string()
                            }
                        })
                    })
                    .collect();
                vec![
                    chunk(&json!({"role": "assistant", "tool_calls": calls}), None),
                    chunk(&json!({}), Some("tool_calls")),
                ]
            }
            None => vec![
                chunk(
                    &json!({"role": "assistant", "content": "REVIEW_SYNTHESIS\nall layers reviewed"}),
                    None,
                ),
                chunk(&json!({}), Some("stop")),
            ],
        }
    } else if model == "project-fit" {
        // The stall (ADR 0028's reason to exist) accepts the first
        // request and never answers. The runtime-failure script emits its
        // error text once to verify it cannot be recorded as a successful
        // review and is retried.
        let calls = project_fit_calls.fetch_add(1, Ordering::SeqCst) + 1;
        if calls >= 2 {
            vec![
                chunk(
                    &json!({"role": "assistant", "content": "project-fit reviewed"}),
                    None,
                ),
                chunk(&json!({}), Some("stop")),
            ]
        } else if matches!(behavior, ReviewMockBehavior::RuntimeMissingThenReply) {
            vec![
                chunk(
                    &json!({
                        "role": "assistant",
                        "content": "The packaged prime-agent-runtime directory was not found"
                    }),
                    None,
                ),
                chunk(&json!({}), Some("stop")),
            ]
        } else {
            std::thread::sleep(Duration::from_secs(600));
            return Ok(());
        }
    } else {
        vec![
            chunk(
                &json!({"role": "assistant", "content": format!("{model} reviewed")}),
                None,
            ),
            chunk(&json!({}), Some("stop")),
        ]
    };
    let mut payload = String::new();
    for part in data {
        write!(payload, "data: {part}\n\n").expect("SSE chunk");
    }
    payload.push_str("data: [DONE]\n\n");
    stream.write_all(
        format!(
            "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nConnection: close\r\n\r\n{payload}"
        )
        .as_bytes(),
    )
}

fn spawn_review_mock(behavior: ReviewMockBehavior) -> (PathBuf, Arc<AtomicUsize>) {
    let listener = TcpListener::bind("127.0.0.1:0").expect("bind mock");
    let url = format!(
        "http://127.0.0.1:{}/v1",
        listener.local_addr().unwrap().port()
    );
    let calls = Arc::new(AtomicUsize::new(0));
    let project_fit_calls = Arc::clone(&calls);
    std::thread::spawn(move || {
        for stream in listener.incoming() {
            let Ok(stream) = stream else { continue };
            let calls = Arc::clone(&project_fit_calls);
            std::thread::spawn(move || {
                let _ = serve_review(stream, &calls, behavior);
            });
        }
    });
    (PathBuf::from(url), calls)
}

/// A provider that refuses every request with a 500: the conductor's
/// wake turn dies before dispatching a single reviewer (the dead
/// credentials / unreachable provider class).
fn serve_dead_review(mut stream: TcpStream) -> std::io::Result<()> {
    let mut reader = BufReader::new(stream.try_clone()?);
    let mut content_length = 0usize;
    loop {
        let mut line = String::new();
        if reader.read_line(&mut line)? == 0 {
            return Ok(());
        }
        if line == "\r\n" {
            break;
        }
        if let Some(value) = line.to_ascii_lowercase().strip_prefix("content-length:") {
            content_length = value.trim().parse().unwrap_or_default();
        }
    }
    let mut body = vec![0; content_length];
    reader.read_exact(&mut body)?;
    stream.write_all(
        b"HTTP/1.1 500 Internal Server Error\r\nContent-Type: application/json\r\nConnection: close\r\n\r\n{\"error\":{\"message\":\"dead provider\"}}",
    )
}

fn spawn_dead_review_mock() -> PathBuf {
    let listener = TcpListener::bind("127.0.0.1:0").expect("bind dead mock");
    let url = format!(
        "http://127.0.0.1:{}/v1",
        listener.local_addr().unwrap().port()
    );
    std::thread::spawn(move || {
        for stream in listener.incoming() {
            let Ok(stream) = stream else { continue };
            std::thread::spawn(move || {
                let _ = serve_dead_review(stream);
            });
        }
    });
    PathBuf::from(url)
}

#[allow(clippy::zombie_processes)]
fn spawn_daemon(socket: &Path, agent_dir: &Path) -> Daemon {
    let child = Command::new(env!("CARGO_BIN_EXE_pa-daemon"))
        .arg("supervisor")
        .arg("--socket")
        .arg(socket)
        .arg("--agent-dir")
        .arg(agent_dir)
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .env(
            pa_daemon::worker::WORKER_SUPERVISOR_LOST_EXIT_MS_ENV,
            "15000",
        )
        .spawn()
        .expect("spawn pa-daemon supervisor");
    let deadline = Instant::now() + Duration::from_secs(10);
    while Instant::now() < deadline {
        if socket.exists() {
            return Daemon {
                child,
                socket: socket.to_path_buf(),
            };
        }
        std::thread::sleep(Duration::from_millis(20));
    }
    panic!("supervisor socket never appeared");
}

fn git(repo: &Path, args: &[&str]) -> String {
    let output = Command::new("git")
        .arg("-C")
        .arg(repo)
        .args(args)
        .env("GIT_AUTHOR_NAME", "Review Test")
        .env("GIT_AUTHOR_EMAIL", "review@example.invalid")
        .env("GIT_COMMITTER_NAME", "Review Test")
        .env("GIT_COMMITTER_EMAIL", "review@example.invalid")
        .output()
        .expect("run git");
    assert!(
        output.status.success(),
        "git {args:?}: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    String::from_utf8(output.stdout)
        .expect("git UTF-8")
        .trim()
        .to_string()
}

fn observer_once(socket: &Path, agent_dir: &Path) -> Output {
    let output = Command::new(env!("CARGO_BIN_EXE_pa-daemon"))
        .arg("observer")
        .arg("--socket")
        .arg(socket)
        .arg("--agent-dir")
        .arg(agent_dir)
        .arg("--once")
        .output()
        .expect("run observer");
    assert!(
        output.status.success(),
        "observer failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    output
}

fn wait_until<T>(deadline: Duration, mut probe: impl FnMut() -> Option<T>) -> T {
    let deadline = Instant::now() + deadline;
    loop {
        if let Some(value) = probe() {
            return value;
        }
        assert!(Instant::now() < deadline, "condition never became true");
        std::thread::sleep(Duration::from_millis(50));
    }
}

/// One enrolled fixture: a real git repository, a real daemon on its own
/// agent dir, a mock provider, and the profile written through init. The
/// temp dir drops after the daemon (field order), so teardown kills the
/// daemon before its directories vanish.
struct Fixture {
    /// Held for teardown order: drops (killing the daemon) before
    /// `_dir` removes the daemon's directories.
    #[allow(dead_code)]
    daemon: Daemon,
    _dir: tempfile::TempDir,
    repo: PathBuf,
    agent_dir: PathBuf,
    socket: PathBuf,
    store: RepositoryStateStore,
}

fn fixture(repo_dir_name: &str, max_attempts: u32) -> Fixture {
    let url = spawn_review_mock(ReviewMockBehavior::StallThenReply).0;
    fixture_with(repo_dir_name, max_attempts, &url, ATTEMPT_TIMEOUT_SECONDS)
}

fn runtime_failure_fixture(repo_dir_name: &str, max_attempts: u32) -> Fixture {
    let url = spawn_review_mock(ReviewMockBehavior::RuntimeMissingThenReply).0;
    fixture_with(repo_dir_name, max_attempts, &url, ATTEMPT_TIMEOUT_SECONDS)
}

/// A dead-provider fixture whose attempt budget is unreachable inside any
/// test deadline: settling at all proves the failure was supervised
/// through the dead-turn fast lane, never the timeout.
fn dead_fixture(repo_dir_name: &str, max_attempts: u32) -> Fixture {
    let url = spawn_dead_review_mock();
    fixture_with(repo_dir_name, max_attempts, &url, 1800)
}

fn fixture_with(
    repo_dir_name: &str,
    max_attempts: u32,
    url: &Path,
    attempt_timeout_seconds: u32,
) -> Fixture {
    let dir = tempfile::TempDir::new().expect("temp dir");
    let repo = dir.path().join(repo_dir_name);
    std::fs::create_dir(&repo).expect("repo");
    git(&repo, &["init", "-q"]);
    std::fs::write(repo.join("code.txt"), "baseline\n").expect("baseline file");
    git(&repo, &["add", "code.txt"]);
    git(&repo, &["commit", "-qm", "baseline"]);

    let agent_dir = dir.path().join("agent");
    std::fs::create_dir_all(agent_dir.join("sessions")).expect("sessions dir");
    let models: Vec<Value> = ["main", "requirements", "project-fit", "implementation"]
        .into_iter()
        .map(|id| {
            json!({
                "id": id, "name": id, "api": "openai-completions",
                "contextWindow": 128_000, "maxTokens": 4096
            })
        })
        .collect();
    std::fs::write(
        agent_dir.join("models.json"),
        json!({
            "providers": { "prime-inference": {
                "api": "openai-completions", "baseUrl": url.to_string_lossy(),
                "apiKey": "sk-review-test", "models": models
            }}
        })
        .to_string(),
    )
    .expect("models.json");

    let socket = dir.path().join("daemon.sock");
    let daemon = spawn_daemon(&socket, &agent_dir);
    let init = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .expect("tokio runtime")
        .block_on(run_init(InitOptions {
            socket_path: socket.clone(),
            agent_dir: agent_dir.clone(),
            repo: repo.clone(),
            branch: None,
            session_name: None,
            main_model: Some("prime-inference/main".to_string()),
            // Distinct layer models: the mock scripts the layers BY MODEL
            // ID, and init's default would run every layer on the main
            // model.
            layers: vec![
                (
                    "requirements".to_string(),
                    "prime-inference/requirements".to_string(),
                ),
                (
                    "project-fit".to_string(),
                    "prime-inference/project-fit".to_string(),
                ),
                (
                    "implementation".to_string(),
                    "prime-inference/implementation".to_string(),
                ),
            ],
            attempt_timeout_seconds: Some(attempt_timeout_seconds),
            max_attempts: Some(max_attempts),
        }))
        .expect("init");
    assert!(init.created_conductor);
    let store = RepositoryStateStore::open(&agent_dir, &repo);
    Fixture {
        daemon,
        _dir: dir,
        repo,
        agent_dir,
        socket,
        store,
    }
}

fn commit_change(repo: &Path, content: &str, message: &str) -> String {
    std::fs::write(repo.join("code.txt"), content).expect("write");
    git(repo, &["add", "code.txt"]);
    git(repo, &["commit", "-qm", message]);
    git(repo, &["rev-parse", "HEAD"])
}

fn observe_until_settled(fixture: &Fixture, deadline: Duration) {
    wait_until(deadline, || {
        observer_once(&fixture.socket, &fixture.agent_dir);
        let state = fixture.store.load().expect("state");
        (state
            .branches
            .values()
            .all(|branch| branch.in_flight.is_none()))
        .then_some(())
    });
}

/// Wait until the observer admits the range (an in-flight range exists).
fn observe_until_admitted(fixture: &Fixture) {
    wait_until(Duration::from_secs(60), || {
        observer_once(&fixture.socket, &fixture.agent_dir);
        fixture
            .store
            .load()
            .expect("state")
            .branches
            .values()
            .any(|branch| branch.in_flight.is_some())
            .then_some(())
    });
}

/// Rewind the in-flight attempt's start stamp into the past, so the next
/// scan sees the budget expired without the test waiting the full
/// (generous, real) budget. The supervision still does its own time
/// arithmetic on the rewound stamp — only the waiting is skipped.
fn age_out_attempt(fixture: &Fixture) {
    let path = fixture.store.state_path();
    wait_until(Duration::from_secs(10), || {
        let state = fixture.store.load().expect("state");
        state
            .branches
            .values()
            .any(|branch| branch.in_flight.is_some())
            .then_some(())
    });
    let body = std::fs::read_to_string(&path).expect("state file");
    let mut state: Value = serde_json::from_str(&body).expect("state json");
    for branch in state["branches"]
        .as_object_mut()
        .expect("branches")
        .values_mut()
    {
        if branch.get("inFlight").is_some_and(|value| !value.is_null()) {
            branch["inFlight"]["attemptStartedAt"] = json!("2020-01-01T00:00:00.000Z");
        }
    }
    std::fs::write(
        &path,
        serde_json::to_string_pretty(&state).expect("serialize"),
    )
    .expect("rewrite state");
}

#[test]
fn a_stalled_attempt_is_cancelled_and_the_retry_completes() {
    let fixture = fixture("repo-retry", 2);
    let base = git(&fixture.repo, &["rev-parse", "HEAD"]);
    let branch = git(&fixture.repo, &["rev-parse", "--abbrev-ref", "HEAD"]);
    let head = commit_change(&fixture.repo, "changed\n", "change");

    // The first attempt stalls (project-fit's reviewer never answers);
    // once the stall has taken hold, rewinding the attempt stamp makes
    // the next scan cancel the attempt and re-arm the range as attempt 2,
    // whose fresh dispatch completes.
    observe_until_admitted(&fixture);
    std::thread::sleep(Duration::from_secs(5));
    age_out_attempt(&fixture);
    // The retry's cold-wake chain (worker spawn, dispatch turn, child
    // turns, synthesis) is slow on a debug build — settle generously.
    observe_until_settled(&fixture, Duration::from_secs(180));

    let state = fixture.store.load().expect("state");
    let branch_state = state.branches[&branch].clone();
    assert!(branch_state.in_flight.is_none());
    assert_eq!(branch_state.cursor.as_deref(), Some(head.as_str()));
    let records = fixture.store.records(&branch).expect("records");
    assert_eq!(records.len(), 1);
    assert_eq!(records[0].base, base);
    assert_eq!(records[0].head, head);
    // The record carries the attempt count the review consumed, and the
    // synthesis unwrapped after the marker line (ADR 0030).
    assert_eq!(records[0].attempts, 2);
    assert_eq!(records[0].layers.len(), 3);
    assert_eq!(
        records[0].conclusion.as_deref(),
        Some("all layers reviewed")
    );
    // The query surface shows the settled range without a failure row.
    let status = load_repository_status(&QueryOptions {
        agent_dir: fixture.agent_dir,
        repo: fixture.repo,
    })
    .expect("status");
    assert!(status.branches[0].last_failure.is_none());
}

#[test]
fn a_missing_packaged_runtime_fails_the_attempt_and_the_retry_completes() {
    let fixture = runtime_failure_fixture("repo-runtime-retry", 2);
    let branch = git(&fixture.repo, &["rev-parse", "--abbrev-ref", "HEAD"]);
    let head = commit_change(&fixture.repo, "changed\n", "change");

    observe_until_settled(&fixture, Duration::from_secs(180));

    let state = fixture.store.load().expect("state");
    let branch_state = &state.branches[&branch];
    assert!(branch_state.in_flight.is_none());
    assert_eq!(
        branch_state.cursor.as_deref(),
        Some(head.as_str()),
        "branch state after runtime recovery: {branch_state:#?}"
    );
    let records = fixture.store.records(&branch).expect("records");
    assert_eq!(records.len(), 1);
    assert_eq!(records[0].attempts, 2);
    assert_eq!(records[0].layers.len(), 3);
    assert!(branch_state.last_failure.is_none());
}

#[test]
fn an_exhausted_range_fails_loudly_and_a_later_range_recovers() {
    let fixture = fixture("repo-fail", 1);
    let branch = git(&fixture.repo, &["rev-parse", "--abbrev-ref", "HEAD"]);
    let base = fixture.store.load().expect("state").branches[&branch]
        .cursor
        .clone()
        .expect("seeded baseline");
    let stalled = commit_change(&fixture.repo, "stalled\n", "stall");

    // The ceiling is one attempt: the stall fails the range loudly — no
    // in-flight range, the cursor holds at the baseline, no record.
    observe_until_admitted(&fixture);
    std::thread::sleep(Duration::from_secs(5));
    age_out_attempt(&fixture);
    observe_until_settled(&fixture, Duration::from_secs(60));
    let state = fixture.store.load().expect("state");
    let branch_state = state.branches[&branch].clone();
    assert!(branch_state.in_flight.is_none());
    assert_eq!(branch_state.cursor.as_deref(), Some(base.as_str()));
    assert!(fixture.store.records(&branch).expect("records").is_empty());
    let failure = branch_state.last_failure.expect("loud failure");
    assert_eq!(failure.base, base);
    assert_eq!(failure.head, stalled);
    assert_eq!(failure.attempts, 1);
    assert_eq!(failure.reason, "timed_out");
    let text = render_status(
        &load_repository_status(&QueryOptions {
            agent_dir: fixture.agent_dir.clone(),
            repo: fixture.repo.clone(),
        })
        .expect("status"),
    );
    assert!(text.contains("last review failed"), "{text}");
    assert!(text.contains("(timed_out)"), "{text}");

    // The next head admits from the same base — the failed commits are
    // re-covered, not swallowed — and completes (the mock's project-fit
    // answers from its second call on).
    let recovered = commit_change(&fixture.repo, "recovered\n", "recover");
    observe_until_settled(&fixture, Duration::from_secs(120));
    let state = fixture.store.load().expect("state");
    let branch_state = state.branches[&branch].clone();
    assert!(branch_state.in_flight.is_none());
    assert_eq!(branch_state.cursor.as_deref(), Some(recovered.as_str()));
    let records = fixture.store.records(&branch).expect("records");
    assert_eq!(records.len(), 1);
    assert_eq!(records[0].base, base);
    assert_eq!(records[0].head, recovered);
    // The failure fact stays visible beside the recovery.
    assert!(branch_state.last_failure.is_some());
}

#[test]
fn an_attempt_that_dies_before_dispatch_fails_within_scans_not_the_budget() {
    // The dead-credential class (the beta.22 first session): the wake
    // turn errors out before dispatching a single reviewer. The attempt
    // budget here is 1800s — far beyond the deadline — so settling at all
    // proves the observer supervised the dead turn at scan pace instead
    // of holding the range hostage to the budget, and the failure is
    // visible with its reason.
    let fixture = dead_fixture("repo-dead", 2);
    let branch = git(&fixture.repo, &["rev-parse", "--abbrev-ref", "HEAD"]);
    let base = fixture.store.load().expect("state").branches[&branch]
        .cursor
        .clone()
        .expect("seeded baseline");
    let head = commit_change(&fixture.repo, "broken\n", "break");

    observe_until_settled(&fixture, Duration::from_secs(180));

    let state = fixture.store.load().expect("state");
    let branch_state = state.branches[&branch].clone();
    assert!(branch_state.in_flight.is_none());
    assert_eq!(branch_state.cursor.as_deref(), Some(base.as_str()));
    assert!(fixture.store.records(&branch).expect("records").is_empty());
    let failure = branch_state.last_failure.expect("loud failure");
    assert_eq!(failure.base, base);
    assert_eq!(failure.head, head);
    assert_eq!(failure.attempts, 2);
    assert_eq!(failure.reason, "turn_failed");
    let text = render_status(
        &load_repository_status(&QueryOptions {
            agent_dir: fixture.agent_dir,
            repo: fixture.repo,
        })
        .expect("status"),
    );
    assert!(text.contains("last review failed"), "{text}");
    assert!(text.contains("(turn_failed)"), "{text}");
}
