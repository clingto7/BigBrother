//! Delivery e2e (ADR 0029): a completed review record delivers through
//! every enabled channel — a GitHub Commit Status under the stable
//! `big-brother/review` context and a Bark push — with per-channel
//! durable state, minute-gated retries after a failure, and no re-send
//! once delivered. Real daemon, real observer binary, mock provider,
//! mock GitHub API, mock Bark server.
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
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde_json::{json, Value};

use pa_daemon::big_brother::init::{run_init, InitOptions};
use pa_daemon::big_brother::state::RepositoryStateStore;

/// One request a delivery mock saw.
#[derive(Debug, Clone)]
struct RecordedRequest {
    method: String,
    path: String,
    authorization: Option<String>,
    body: Value,
}

/// Read one HTTP request (headers plus a content-length body) and hand
/// it to the responder, which returns the status and body to write.
fn serve_one(
    mut stream: TcpStream,
    respond: impl FnOnce(RecordedRequest) -> (u16, String),
) -> std::io::Result<()> {
    let mut reader = BufReader::new(stream.try_clone()?);
    let mut request_line = String::new();
    reader.read_line(&mut request_line)?;
    let mut method = String::new();
    let mut path = String::new();
    if let Some(head) = request_line
        .split_whitespace()
        .collect::<Vec<_>>()
        .get(0..2)
    {
        method = head[0].to_string();
        path = head[1].to_string();
    }
    let mut content_length = 0usize;
    let mut authorization = None;
    loop {
        let mut line = String::new();
        if reader.read_line(&mut line)? == 0 {
            return Ok(());
        }
        if line == "\r\n" {
            break;
        }
        let lower = line.to_ascii_lowercase();
        if let Some(value) = lower.strip_prefix("content-length:") {
            content_length = value.trim().parse().unwrap_or_default();
        }
        if lower.starts_with("authorization:") {
            authorization = line
                .split_once(':')
                .map(|(_, value)| value.trim().to_string());
        }
    }
    let mut body = vec![0; content_length];
    reader.read_exact(&mut body)?;
    let parsed = serde_json::from_slice(&body)
        .map_err(|error| std::io::Error::other(format!("delivery body: {error}")))?;
    let (status, response_body) = respond(RecordedRequest {
        method,
        path,
        authorization,
        body: parsed,
    });
    let reason = match status {
        200 => "OK",
        201 => "Created",
        _ => "Internal Server Error",
    };
    write!(
        stream,
        "HTTP/1.1 {status} {reason}\r\nContent-Type: application/json\r\nConnection: close\r\n\r\n{response_body}"
    )
    .expect("write mock response");
    Ok(())
}

type Requests = Arc<Mutex<Vec<RecordedRequest>>>;

/// A mock GitHub API that accepts commit statuses and records every
/// request.
fn spawn_github_mock() -> (String, Requests) {
    let listener = TcpListener::bind("127.0.0.1:0").expect("bind github mock");
    let requests: Requests = Arc::new(Mutex::new(Vec::new()));
    let url = format!("http://127.0.0.1:{}", listener.local_addr().unwrap().port());
    let recorded = Arc::clone(&requests);
    std::thread::spawn(move || {
        for stream in listener.incoming() {
            let Ok(stream) = stream else { continue };
            let recorded = Arc::clone(&recorded);
            std::thread::spawn(move || {
                let _ = serve_one(stream, |request| {
                    recorded.lock().expect("github mock lock").push(request);
                    (201, "{\"state\": \"success\"}".to_string())
                });
            });
        }
    });
    (url, requests)
}

/// A mock Bark server that fails its first `fail_first` pushes with a
/// 500, then answers the success shape.
fn spawn_bark_mock(fail_first: usize) -> (String, Requests) {
    let listener = TcpListener::bind("127.0.0.1:0").expect("bind bark mock");
    let requests: Requests = Arc::new(Mutex::new(Vec::new()));
    let url = format!("http://127.0.0.1:{}", listener.local_addr().unwrap().port());
    let recorded = Arc::clone(&requests);
    let served = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    std::thread::spawn(move || {
        for stream in listener.incoming() {
            let Ok(stream) = stream else { continue };
            let recorded = Arc::clone(&recorded);
            let served = Arc::clone(&served);
            std::thread::spawn(move || {
                let _ = serve_one(stream, |request| {
                    recorded.lock().expect("bark mock lock").push(request);
                    let nth = served.fetch_add(1, std::sync::atomic::Ordering::SeqCst) + 1;
                    if nth <= fail_first {
                        (
                            500,
                            "{\"code\": 500, \"message\": \"upstream down\"}".to_string(),
                        )
                    } else {
                        (200, "{\"code\": 200}".to_string())
                    }
                });
            });
        }
    });
    (url, requests)
}

fn chunk(delta: &Value, finish_reason: Option<&str>) -> String {
    json!({
        "id": "chatcmpl-delivery",
        "object": "chat.completion.chunk",
        "created": 1_750_000_000,
        "model": "mock-1",
        "choices": [{"index": 0, "delta": delta, "finish_reason": finish_reason}],
    })
    .to_string()
}

/// The review provider mock (the known-good shape from the sibling
/// e2e's): the conductor (model `main`) dispatches the three layers for
/// a range it has not yet dispatched, answers text otherwise; every
/// layer model answers once.
fn serve_review(mut stream: TcpStream) -> std::io::Result<()> {
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
    let request_text = request.to_string();
    let dispatch_target = || -> Option<(String, String)> {
        let (base, head) = request_text
            .rsplit_once("REVIEW_RANGE ")
            .and_then(|(_, suffix)| suffix.split_once(" END"))
            .and_then(|(range, _)| range.split_once(".."))?;
        if base.starts_with('<') {
            return None;
        }
        if request_text.contains(&format!("for {base}..{head}")) {
            return None;
        }
        Some((base.to_string(), head.to_string()))
    }();
    let data = if model == "main" {
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
                    &json!({"role": "assistant", "content": "review dispatched"}),
                    None,
                ),
                chunk(&json!({}), Some("stop")),
            ],
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

fn spawn_review_mock() -> PathBuf {
    let listener = TcpListener::bind("127.0.0.1:0").expect("bind mock");
    let url = format!(
        "http://127.0.0.1:{}/v1",
        listener.local_addr().unwrap().port()
    );
    std::thread::spawn(move || {
        for stream in listener.incoming() {
            let Ok(stream) = stream else { continue };
            std::thread::spawn(move || {
                let _ = serve_review(stream);
            });
        }
    });
    PathBuf::from(url)
}

struct Daemon {
    child: Child,
    #[allow(dead_code)]
    socket: PathBuf,
}

impl Drop for Daemon {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
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

/// Run the observer binary once with the delivery channels pointed at
/// the mocks (ADR 0029: channels resolve from the observer's env).
fn observer_once(socket: &Path, agent_dir: &Path, delivery_env: &[(&str, &str)]) {
    let output = Command::new(env!("CARGO_BIN_EXE_pa-daemon"))
        .arg("observer")
        .arg("--socket")
        .arg(socket)
        .arg("--agent-dir")
        .arg(agent_dir)
        .arg("--once")
        .envs(delivery_env.iter().copied())
        .output()
        .expect("run observer");
    assert!(
        output.status.success(),
        "observer failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
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

/// One enrolled fixture: a real git repository with a GitHub origin, a
/// real daemon, the mock provider, and the profile written through
/// init. The temp dir drops after the daemon (field order).
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

fn fixture(repo_dir_name: &str) -> Fixture {
    let dir = tempfile::TempDir::new().expect("temp dir");
    let repo = dir.path().join(repo_dir_name);
    std::fs::create_dir_all(&repo).expect("repo");
    git(&repo, &["init", "-q"]);
    std::fs::write(repo.join("code.txt"), "baseline\n").expect("baseline file");
    git(&repo, &["add", "code.txt"]);
    git(&repo, &["commit", "-qm", "baseline"]);
    // The Commit Status channel's target (ADR 0029): a GitHub origin.
    git(
        &repo,
        &[
            "remote",
            "add",
            "origin",
            "https://github.com/example/repo.git",
        ],
    );

    let agent_dir = dir.path().join("agent");
    std::fs::create_dir_all(agent_dir.join("sessions")).expect("sessions dir");
    let url = spawn_review_mock();
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
            attempt_timeout_seconds: None,
            max_attempts: None,
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

/// Rewind a pending channel's last attempt into the past, so the next
/// scan sees the retry window elapsed without the test waiting the
/// real (minute) window.
fn backdate_bark_attempt(fixture: &Fixture, branch: &str, head: &str) {
    let repos = fixture.agent_dir.join("big-brother").join("repos");
    let entries: Vec<PathBuf> = std::fs::read_dir(&repos)
        .expect("repos dir")
        .map(|entry| entry.expect("repo entry").path())
        .collect();
    assert_eq!(entries.len(), 1, "one enrolled repository");
    let path = entries[0]
        .join("records")
        .join(branch)
        .join(format!("{head}.json"));
    let body = std::fs::read_to_string(&path).expect("record file");
    let mut record: Value = serde_json::from_str(&body).expect("record json");
    record["delivery"]["bark"]["lastAttemptAt"] = json!("2020-01-01T00:00:00.000Z");
    std::fs::write(
        &path,
        serde_json::to_string_pretty(&record).expect("serialize"),
    )
    .expect("rewrite record");
}

/// The observer env pointing both channels at the mocks.
fn delivery_env(github_url: &str, bark_url: &str) -> Vec<(&'static str, String)> {
    vec![
        ("BIG_BROTHER_GITHUB_TOKEN", "gh-e2e-token".to_string()),
        ("BIG_BROTHER_GITHUB_API_URL", github_url.to_string()),
        ("BARK_KEY", "e2e-bark-key".to_string()),
        ("BARK_SERVER", bark_url.to_string()),
    ]
}

fn owned_env<'a>(pairs: &'a [(&'static str, String)]) -> Vec<(&'static str, &'a str)> {
    pairs
        .iter()
        .map(|(name, value)| (*name, value.as_str()))
        .collect()
}

#[test]
fn completed_records_deliver_to_commit_status_and_bark() {
    let fixture = fixture("repo-deliver");
    let branch = git(&fixture.repo, &["rev-parse", "--abbrev-ref", "HEAD"]);
    let base = git(&fixture.repo, &["rev-parse", "HEAD"]);
    let head = commit_change(&fixture.repo, "changed\n", "change");
    let (github_url, github_requests) = spawn_github_mock();
    let (bark_url, bark_requests) = spawn_bark_mock(0);
    let env = delivery_env(&github_url, &bark_url);
    let env = owned_env(&env);

    // Scan until the record is delivered on both channels.
    wait_until(Duration::from_secs(120), || {
        observer_once(&fixture.socket, &fixture.agent_dir, &env);
        let records = fixture.store.records(&branch).expect("records");
        records
            .first()
            .is_some_and(|record| {
                record.delivery["commit-status"].delivered() && record.delivery["bark"].delivered()
            })
            .then_some(())
    });

    // The Commit Status: one advisory success under the stable context,
    // on the range's head, authenticated by the configured token.
    let requests = github_requests.lock().expect("github lock").clone();
    assert_eq!(requests.len(), 1, "exactly one status POST");
    let status = &requests[0];
    assert_eq!(status.method, "POST");
    assert_eq!(status.path, format!("/repos/example/repo/statuses/{head}"));
    assert_eq!(status.authorization.as_deref(), Some("Bearer gh-e2e-token"));
    assert_eq!(status.body["state"], json!("success"));
    assert_eq!(status.body["context"], json!("big-brother/review"));
    assert_eq!(status.body["description"], json!("review dispatched"));

    // The Bark push: the key in the path, one synthesis line in the body.
    let pushes = bark_requests.lock().expect("bark lock").clone();
    assert_eq!(pushes.len(), 1, "exactly one push");
    let push = &pushes[0];
    assert_eq!(push.method, "POST");
    assert_eq!(push.path, "/e2e-bark-key");
    assert_eq!(push.body["title"], json!("big-brother repo-deliver"));
    assert_eq!(push.body["group"], json!("big-brother"));
    assert_eq!(
        push.body["body"],
        json!(format!(
            "reviewed {}..{}: review dispatched",
            &base[..8],
            &head[..8]
        ))
    );

    // Delivered channels never re-send (ADR 0029: at-least-once, not
    // forever).
    observer_once(&fixture.socket, &fixture.agent_dir, &env);
    observer_once(&fixture.socket, &fixture.agent_dir, &env);
    assert_eq!(github_requests.lock().expect("github lock").len(), 1);
    assert_eq!(bark_requests.lock().expect("bark lock").len(), 1);
}

#[test]
fn a_failed_channel_retries_on_a_later_scan() {
    let fixture = fixture("repo-retry-deliver");
    let branch = git(&fixture.repo, &["rev-parse", "--abbrev-ref", "HEAD"]);
    let head = commit_change(&fixture.repo, "changed\n", "change");
    let (github_url, github_requests) = spawn_github_mock();
    // The first push fails; the channel stays pending with its error.
    let (bark_url, bark_requests) = spawn_bark_mock(1);
    let env = delivery_env(&github_url, &bark_url);
    let env = owned_env(&env);

    wait_until(Duration::from_secs(120), || {
        observer_once(&fixture.socket, &fixture.agent_dir, &env);
        let records = fixture.store.records(&branch).expect("records");
        records
            .first()
            .is_some_and(|record| {
                record.delivery["commit-status"].delivered() && record.delivery.contains_key("bark")
            })
            .then_some(())
    });
    let record = fixture.store.records(&branch).expect("records")[0].clone();
    let bark = &record.delivery["bark"];
    assert!(!bark.delivered(), "the failed push stays pending");
    assert_eq!(bark.attempts, 1);
    let error = bark.last_error.as_deref().expect("the failure reason");
    assert!(error.contains("500"), "{error}");
    // The healthy channel is not held back by the failing one.
    assert!(record.delivery["commit-status"].delivered());
    assert_eq!(github_requests.lock().expect("github lock").len(), 1);

    // Within the retry window a scan does not even attempt the send…
    observer_once(&fixture.socket, &fixture.agent_dir, &env);
    assert_eq!(bark_requests.lock().expect("bark lock").len(), 1);
    // …and once the window elapsed (backdated), the next scan delivers.
    backdate_bark_attempt(&fixture, &branch, &head);
    wait_until(Duration::from_secs(60), || {
        observer_once(&fixture.socket, &fixture.agent_dir, &env);
        fixture.store.records(&branch).expect("records")[0].delivery["bark"]
            .delivered()
            .then_some(())
    });
    let bark = &fixture.store.records(&branch).expect("records")[0].delivery["bark"];
    assert_eq!(bark.attempts, 2, "the retry is the second attempt");
    assert_eq!(bark.last_error, None);
    assert_eq!(bark_requests.lock().expect("bark lock").len(), 2);
    assert_eq!(github_requests.lock().expect("github lock").len(), 1);
}
