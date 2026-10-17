//! Enrollment e2e: `run_init` (the `big-brother init` boundary) enrolls a
//! real git repository against a real daemon, the observer binary drives
//! the admitted range to a completed record, the query surface reads it
//! back, and a daemon restart plus another scan never re-reviews the
//! completed range (ADR 0022/0025/0027).
//!
//! Run with a short TMPDIR (`TMPDIR=/tmp/bbtest/`): the daemon's Unix
//! socket path must stay under `SUN_LEN` on macOS.
// Stack-resident futures by design on the daemon's hot paths.
#![allow(clippy::large_futures)]
// Narrowing casts sit at OS boundaries (pid/fd/time/size) where the kernel
// bounds the values.
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
use std::time::{Duration, Instant};

use serde_json::{json, Value};

use pa_daemon::big_brother::init::{run_init, InitOptions};
use pa_daemon::big_brother::query::{load_repository_status, render_status, QueryOptions};
use pa_daemon::big_brother::state::RepositoryStateStore;

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

fn chunk(delta: &Value, finish_reason: Option<&str>) -> String {
    json!({
        "id": "chatcmpl-init",
        "object": "chat.completion.chunk",
        "created": 1_750_000_000,
        "model": "mock-1",
        "choices": [{"index": 0, "delta": delta, "finish_reason": finish_reason}],
    })
    .to_string()
}

/// The review provider mock, content-driven (the wake request's range is
/// the script's discriminator): the conductor (model `main`) dispatches
/// the three configured layers for a range it has not yet dispatched
/// (the placeholder guard keeps the system prompt's own `REVIEW_RANGE`
/// mention from matching), answers text otherwise; each layer model
/// answers once. The wake is the conductor's first turn — init sends no
/// bootstrap, so the first `main` call already carries the real range.
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
        // The LAST marker is the user message: the conductor system prompt
        // also names the REVIEW_RANGE shape.
        let (base, head) = request_text
            .rsplit_once("REVIEW_RANGE ")
            .and_then(|(_, suffix)| suffix.split_once(" END"))
            .and_then(|(range, _)| range.split_once(".."))?;
        if base.starts_with('<') {
            return None;
        }
        // Already dispatched for this head: the tool results say
        // "reviewer spawned as child ... for <base>..<head>".
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

#[allow(clippy::zombie_processes)]
fn spawn_daemon(socket: &Path, agent_dir: &Path) -> Daemon {
    let child = Command::new(env!("CARGO_BIN_EXE_pa-daemon"))
        .arg("supervisor")
        .arg("--socket")
        .arg(socket)
        .arg("--agent-dir")
        .arg(agent_dir)
        // The daemon's env pair is the spawn fallback a woken worker must
        // not prefer over its session file's pinned model: mock-1 differs
        // from every review profile model here on purpose.
        .env("PRIME_AGENT_MODEL_PROVIDER", "prime-inference")
        .env("PRIME_AGENT_MODEL", "mock-1")
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

/// Run the observer binary once; its own scan failure is a test failure.
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

fn init_options(socket: &Path, agent_dir: &Path, repo: &Path) -> InitOptions {
    InitOptions {
        socket_path: socket.to_path_buf(),
        agent_dir: agent_dir.to_path_buf(),
        repo: repo.to_path_buf(),
        branch: None,
        session_name: None,
        main_model: Some("prime-inference/main".to_string()),
        layers: Vec::new(),
        attempt_timeout_seconds: None,
        max_attempts: None,
    }
}

#[test]
fn init_enrolls_reviews_queries_and_survives_a_restart() {
    let dir = tempfile::TempDir::new().expect("temp dir");
    let repo = dir.path().join("repo");
    std::fs::create_dir(&repo).expect("repo");
    git(&repo, &["init", "-q"]);
    std::fs::write(repo.join("code.txt"), "baseline\n").expect("baseline file");
    git(&repo, &["add", "code.txt"]);
    git(&repo, &["commit", "-qm", "baseline"]);
    let base = git(&repo, &["rev-parse", "HEAD"]);
    let branch = git(&repo, &["rev-parse", "--abbrev-ref", "HEAD"]);

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

    // Enrollment through the product boundary.
    let outcome = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .expect("tokio runtime")
        .block_on(run_init(init_options(&socket, &agent_dir, &repo)))
        .expect("init");
    assert_eq!(outcome.git_root, repo);
    assert_eq!(outcome.branch, branch);
    assert_eq!(outcome.cursor, base);
    assert_eq!(outcome.session_name, "review-repo");
    assert!(outcome.created_conductor);
    assert!(outcome.profile_path.is_file());
    assert!(outcome.assets_dir.join("overview.md").is_file());

    // The durable state records the git root and the seeded baseline.
    let store = RepositoryStateStore::open(&agent_dir, &repo);
    let state = store.load().expect("repository state after init");
    assert_eq!(
        state.git_root.as_deref(),
        Some(repo.to_str().expect("repo path is UTF-8"))
    );
    assert_eq!(
        state.branches[&branch].cursor.as_deref(),
        Some(base.as_str())
    );

    // Re-running init is idempotent: no second conductor, same baseline.
    let again = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .expect("tokio runtime")
        .block_on(run_init(init_options(&socket, &agent_dir, &repo)))
        .expect("re-init");
    assert!(!again.created_conductor);
    assert_eq!(again.cursor, base);

    // A new commit on the tracked branch becomes a review range only
    // through the observer.
    std::fs::write(repo.join("code.txt"), "changed\n").expect("new content");
    git(&repo, &["add", "code.txt"]);
    git(&repo, &["commit", "-qm", "change"]);
    let head = git(&repo, &["rev-parse", "HEAD"]);
    assert_ne!(base, head);

    wait_until(Duration::from_secs(120), || {
        observer_once(&socket, &agent_dir);
        let state = store.load().expect("state during review");
        let branch_state = state.branches.get(&branch).expect("branch state");
        (branch_state.in_flight.is_none() && branch_state.cursor.as_deref() == Some(head.as_str()))
            .then_some(())
    });

    // The completed record carries every configured layer and a synthesis.
    let records = store.records(&branch).expect("records");
    assert_eq!(records.len(), 1);
    assert_eq!(records[0].base, base);
    assert_eq!(records[0].head, head);
    assert_eq!(records[0].layers.len(), 3);
    assert!(records[0].conclusion.is_some());

    // The operator query surface reads the same durable facts.
    let status = load_repository_status(&QueryOptions {
        agent_dir: agent_dir.clone(),
        repo,
    })
    .expect("query");
    assert_eq!(status.branches.len(), 1);
    assert_eq!(status.branches[0].name, branch);
    assert_eq!(status.branches[0].cursor.as_deref(), Some(head.as_str()));
    let text = render_status(&status);
    assert!(text.contains(&head[..12]), "{text}");
    assert!(text.contains("1 completed review(s)"), "{text}");

    // A daemon restart plus another scan never re-reviews the completed
    // range: the cursor holds, no range goes in flight, one record stays.
    drop(daemon);
    std::fs::remove_file(&socket).ok();
    let restarted = spawn_daemon(&socket, &agent_dir);
    observer_once(&socket, &agent_dir);
    let state = store.load().expect("state after restart");
    let branch_state = state.branches.get(&branch).expect("branch state");
    assert_eq!(branch_state.cursor.as_deref(), Some(head.as_str()));
    assert!(branch_state.in_flight.is_none());
    assert_eq!(store.records(&branch).expect("records").len(), 1);
    drop(restarted);
}
