//! Saved-session wake e2e: a `send_message` targeting a saved-but-inactive
//! session wakes it (catalog-resolve, spawn a worker over the saved file,
//! deliver); a second send reuses the resident worker, and an unknown
//! selector keeps the TS unknown-session error.
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
use std::os::unix::net::UnixStream;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use serde_json::{json, Value};

use pa_daemon::big_brother::state::{
    Admission, Completion, RepositoryStateStore, ReviewRecord, ReviewRecordLayer,
};

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

fn spawn_mock(answer: &'static str) -> PathBuf /* url */ {
    let listener = TcpListener::bind("127.0.0.1:0").expect("bind mock");
    let url = format!(
        "http://127.0.0.1:{}/v1",
        listener.local_addr().unwrap().port()
    );
    std::thread::spawn(move || {
        for stream in listener.incoming() {
            let Ok(stream) = stream else { continue };
            std::thread::spawn(move || {
                let _ = serve(stream, answer);
            });
        }
    });
    PathBuf::from(url)
}

fn chunk(delta: &Value, finish_reason: Option<&str>) -> String {
    json!({
        "id": "chatcmpl-wake",
        "object": "chat.completion.chunk",
        "created": 1_750_000_000,
        "model": "mock-1",
        "choices": [{"index": 0, "delta": delta, "finish_reason": finish_reason}],
    })
    .to_string()
}

fn serve(mut stream: TcpStream, answer: &str) -> std::io::Result<()> {
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
        let lower = line.to_ascii_lowercase();
        if let Some(value) = lower.strip_prefix("content-length:") {
            content_length = value.trim().parse().unwrap_or_default();
        }
    }
    let mut body = vec![0u8; content_length];
    if content_length > 0 {
        reader.read_exact(&mut body)?;
    }
    let mut payload = String::new();
    for data in [
        chunk(&json!({"role": "assistant", "content": answer}), None),
        chunk(&json!({}), Some("stop")),
    ] {
        write!(payload, "data: {data}\n\n").expect("write to String");
    }
    payload.push_str("data: [DONE]\n\n");
    stream.write_all(
        format!(
            "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nConnection: close\r\n\r\n{payload}"
        )
        .as_bytes(),
    )
}

fn spawn_review_mock(main_calls: Arc<AtomicUsize>) -> PathBuf {
    let listener = TcpListener::bind("127.0.0.1:0").expect("bind review mock");
    let url = format!(
        "http://127.0.0.1:{}/v1",
        listener.local_addr().unwrap().port()
    );
    std::thread::spawn(move || {
        for stream in listener.incoming() {
            let Ok(stream) = stream else { continue };
            let calls = Arc::clone(&main_calls);
            std::thread::spawn(move || {
                let _ = serve_review(stream, &calls);
            });
        }
    });
    PathBuf::from(url)
}

fn serve_review(mut stream: TcpStream, main_calls: &AtomicUsize) -> std::io::Result<()> {
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
    let data = if model == "main" {
        let index = main_calls.fetch_add(1, Ordering::SeqCst);
        // Content-driven script (ranges repeat across wakes): bootstrap
        // is the first call; a wake whose head has no dispatched reviewer
        // yet dispatches; every later turn of the same range answers text.
        let dispatch_turn = index != 0
            && (|| {
                let request_text = request.to_string();
                // The LAST marker is the user message: the conductor
                // system prompt also names the REVIEW_RANGE shape.
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
                Some(())
            })()
            .is_some();
        if dispatch_turn {
            let request_text = request.to_string();
            let (base, head) = request_text
                .rsplit_once("REVIEW_RANGE ")
                .and_then(|(_, suffix)| suffix.split_once(" END"))
                .and_then(|(range, _)| range.split_once(".."))
                .expect("wake request contains fixed range");
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
        } else if index == 0 {
            vec![
                chunk(&json!({"role": "assistant", "content": "ready"}), None),
                chunk(&json!({}), Some("stop")),
            ]
        } else {
            vec![
                chunk(
                    &json!({"role": "assistant", "content": "review dispatched"}),
                    None,
                ),
                chunk(&json!({}), Some("stop")),
            ]
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
    stream.write_all(format!("HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nConnection: close\r\n\r\n{payload}").as_bytes())
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
        // from every review profile model here on purpose, so a model
        // restoration regression fails the review flow loudly.
        .env("PRIME_AGENT_MODEL_PROVIDER", "prime-inference")
        .env("PRIME_AGENT_MODEL", "mock-1")
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        // A supervisor killed at teardown must not leak its session workers
        // into later test binaries: the worker's supervisor-lost exit runs
        // on this short window instead of the 5-minute default.
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

struct Client {
    reader: BufReader<UnixStream>,
    writer: UnixStream,
}

impl Client {
    fn connect(socket: &Path) -> (Self, Value) {
        let deadline = Instant::now() + Duration::from_secs(5);
        let stream = loop {
            match UnixStream::connect(socket) {
                Ok(stream) => break stream,
                Err(_) if Instant::now() < deadline => {
                    std::thread::sleep(Duration::from_millis(20));
                }
                Err(error) => panic!("connect supervisor: {error}"),
            }
        };
        let writer = stream.try_clone().expect("clone socket");
        let mut client = Client {
            reader: BufReader::new(stream),
            writer,
        };
        let hello = client.read_line();
        (client, hello)
    }

    fn send_command(&mut self, id: &str, command: &Value) {
        let envelope = json!({
            "type": "command",
            "id": id,
            "protocol": { "name": "prime-agent.daemon", "version": 7 },
            "command": command,
        });
        let mut line = serde_json::to_string(&envelope).expect("serialize command");
        line.push('\n');
        self.writer.write_all(line.as_bytes()).expect("send");
        self.writer.flush().expect("flush");
    }

    fn read_line(&mut self) -> Value {
        let mut line = String::new();
        let deadline = Instant::now() + Duration::from_secs(30);
        self.reader
            .get_mut()
            .set_read_timeout(Some(Duration::from_millis(100)))
            .expect("set timeout");
        loop {
            match self.reader.read_line(&mut line) {
                Ok(0) => panic!("supervisor closed the connection"),
                Ok(_) if line.trim().is_empty() => line.clear(),
                Ok(_) => return serde_json::from_str(line.trim()).expect("parse line"),
                Err(error) => {
                    assert!(
                        Instant::now() < deadline,
                        "timed out waiting for supervisor line: {error}"
                    );
                }
            }
        }
    }

    fn read_response(&mut self, id: &str) -> Value {
        let deadline = Instant::now() + Duration::from_mins(1);
        loop {
            assert!(Instant::now() < deadline, "no response for id {id}");
            let line = self.read_line();
            if line.get("id").and_then(Value::as_str) == Some(id) {
                return line;
            }
        }
    }
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

fn messages(client: &mut Client, id: &str, active_session_id: &str) -> String {
    client.send_command(
        id,
        &json!({ "type": "get_messages", "activeSessionId": active_session_id }),
    );
    let response = client.read_response(id);
    assert_eq!(response["success"], true, "get_messages failed: {response}");
    serde_json::to_string(&response["data"]).expect("messages json")
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

/// Write the repository's review profile (ADR 0024) under the agent dir:
/// the wake name, the main model, and the three layer models. Stored
/// outside the work tree on purpose — reviewed content must not edit the
/// reviewer's operating rules.
fn write_review_profile(agent_dir: &Path, repo: &Path) {
    let path = pa_daemon::big_brother::profile::profile_path(agent_dir, repo);
    std::fs::create_dir_all(path.parent().expect("profile dir")).expect("profile dir");
    std::fs::write(
        &path,
        json!({
            "version": 1,
            "sessionName": "review-main",
            "mainModel": "prime-inference/main",
            "layers": [
                { "name": "requirements", "model": "prime-inference/requirements" },
                { "name": "project-fit", "model": "prime-inference/project-fit" },
                { "name": "implementation", "model": "prime-inference/implementation" }
            ]
        })
        .to_string(),
    )
    .expect("review profile");
}

#[test]
fn restarted_observer_wakes_restricted_main_and_dispatches_real_review_children() {
    let dir = tempfile::TempDir::new().expect("temp dir");
    let repo = dir.path().join("repo");
    std::fs::create_dir(&repo).expect("repo");
    git(&repo, &["init", "-q"]);
    std::fs::write(repo.join("code.txt"), "baseline\n").expect("baseline file");
    git(&repo, &["add", "code.txt"]);
    git(&repo, &["commit", "-qm", "baseline"]);
    let base = git(&repo, &["rev-parse", "HEAD"]);

    let agent_dir = dir.path().join("agent");
    let sessions = agent_dir.join("sessions");
    std::fs::create_dir_all(&sessions).expect("sessions dir");
    let main_calls = Arc::new(AtomicUsize::new(0));
    let url = spawn_review_mock(Arc::clone(&main_calls));
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
    let branch = git(&repo, &["rev-parse", "--abbrev-ref", "HEAD"]);
    let store = RepositoryStateStore::open(&agent_dir, &repo);
    // Enrollment seeds the baseline cursor through the product boundary
    // (the dedicated `init` command owns this in a later increment).
    store
        .seed_cursor(&branch, &base)
        .expect("seed baseline cursor");
    write_review_profile(&agent_dir, &repo);
    let socket = dir.path().join("daemon.sock");
    let daemon = spawn_daemon(&socket, &agent_dir);
    let (mut client, _) = Client::connect(&socket);
    client.send_command(
        "create",
        &json!({
            "type": "create", "name": "review-main",
            "config": { "cwd": repo, "sessionDir": sessions,
                "bigBrotherReview": true }
        }),
    );
    let created = client.read_response("create");
    assert_eq!(created["success"], true, "{created}");
    let active_id = created["data"]["id"]
        .as_str()
        .or_else(|| created["data"]["activeSessionId"].as_str())
        .expect("active id")
        .to_string();
    client.send_command(
        "bootstrap",
        &json!({
            "type": "prompt_and_wait", "activeSessionId": active_id, "message": "bootstrap"
        }),
    );
    assert_eq!(client.read_response("bootstrap")["success"], true);
    client.send_command(
        "kill",
        &json!({ "type": "kill", "activeSessionId": active_id }),
    );
    assert_eq!(client.read_response("kill")["success"], true);
    drop(client);
    drop(daemon);
    std::fs::remove_file(&socket).ok();

    std::fs::write(repo.join("code.txt"), "changed\n").expect("new content");
    git(&repo, &["add", "code.txt"]);
    git(&repo, &["commit", "-qm", "change"]);
    let head = git(&repo, &["rev-parse", "HEAD"]);
    assert_ne!(base, head);

    let restarted = spawn_daemon(&socket, &agent_dir);
    let (mut client, _) = Client::connect(&socket);
    client.send_command("list", &json!({ "type": "list" }));
    assert_eq!(
        client.read_response("list")["data"]["sessions"]
            .as_array()
            .map(Vec::len),
        Some(0)
    );
    // The durable repository state survived the daemon restart: the cursor
    // holds the seeded baseline and no range is in flight.
    let state = store.load().expect("reload repository state");
    let branch_state = state.branches.get(&branch).expect("branch state");
    let stored_base = branch_state.cursor.clone().expect("seeded cursor");
    let observed_head = git(&repo, &["rev-parse", "HEAD"]);
    assert_eq!(stored_base, base);
    assert_eq!(observed_head, head);
    assert!(branch_state.in_flight.is_none());
    // The observer admits the new range through the product boundary.
    let range = match store
        .admit(&branch, &observed_head)
        .expect("admit the observed range")
    {
        Admission::Admitted(range) => range,
        other => panic!("expected a fresh admission, got {other:?}"),
    };
    assert_eq!(range.base, base);
    assert_eq!(range.head, head);
    client.send_command(
        "wake",
        &json!({
            "type": "send_message", "targetActiveSessionId": "review-main",
            "message": format!("REVIEW_RANGE {}..{} END", range.base, range.head)
        }),
    );
    let wake = client.read_response("wake");
    assert_eq!(wake["success"], true, "{wake}");
    let woken_id = wake["data"]["target"]["activeSessionId"]
        .as_str()
        .expect("woken id");
    assert_ne!(woken_id, active_id);
    let parent_messages = wait_until(Duration::from_secs(90), || {
        let text = messages(&mut client, "parent-messages", woken_id);
        (text.contains("review dispatched") && text.matches("dispatch_review").count() >= 3)
            .then_some(text)
    });
    assert!(
        !parent_messages.contains("Unknown tool"),
        "{parent_messages}"
    );

    // The cold-wake model restoration (ADR 0023): the woken main session
    // runs on the model its file pins — the profile's main model, seeded
    // at creation — never the daemon's env fallback (mock-1). The
    // discriminating mock would have answered plain text on mock-1 and
    // never dispatched, so the flow above already proves it; the roster
    // row pins the fact explicitly.
    client.send_command("woken-roster", &json!({ "type": "list" }));
    let roster = client.read_response("woken-roster");
    let woken_model = roster["data"]["sessions"]
        .as_array()
        .expect("roster sessions")
        .iter()
        .find(|row| row["sessionName"] == "review-main")
        .expect("woken review-main on the roster")
        .get("model")
        .cloned()
        .expect("woken model");
    assert_eq!(woken_model["provider"], "prime-inference");
    assert_eq!(woken_model["id"], "main");

    let layers = ["requirements", "project-fit", "implementation"];
    let child_summaries = wait_until(Duration::from_secs(90), || {
        client.send_command("children", &json!({ "type": "list" }));
        let response = client.read_response("children");
        let sessions = response["data"]["sessions"].as_array()?;
        let children: Vec<Value> = sessions
            .iter()
            .filter(|row| {
                layers
                    .iter()
                    .any(|layer| row["sessionName"] == format!("{layer}-{head}"))
            })
            .cloned()
            .collect();
        (children.len() == 3).then_some(children)
    });
    let mut child_ids = std::collections::BTreeMap::new();
    let mut child_answers = std::collections::BTreeMap::new();
    for layer in layers {
        let child = child_summaries
            .iter()
            .find(|row| row["sessionName"] == format!("{layer}-{head}"))
            .expect("child");
        assert_eq!(child["model"]["provider"], "prime-inference");
        assert_eq!(child["model"]["id"], layer);
        let child_id = child["id"]
            .as_str()
            .or_else(|| child["activeSessionId"].as_str())
            .expect("child id");
        let answer = wait_until(Duration::from_secs(90), || {
            let text = messages(&mut client, "child-messages", child_id);
            text.contains(&format!("{layer} reviewed")).then_some(text)
        });
        assert!(
            answer.contains(&format!("Review {layer} for {base}..{head}")),
            "{answer}"
        );
        child_ids.insert(layer.to_string(), child_id.to_string());
        child_answers.insert(layer.to_string(), format!("{layer} reviewed"));
    }

    // The review conversation (ADR 0026): the transcript carries the
    // dispatch calls and the conductor's synthesis; the layers' full
    // answers come from the children themselves (observer-side
    // collection — a mid-turn wait would deadlock the spawn deferral).
    // The product collector assembles the record from both.
    let transcript: Value =
        serde_json::from_str(&messages(&mut client, "harvest", woken_id)).expect("transcript json");
    let harvested = pa_daemon::big_brother::harvest::harvest_review(&transcript, &child_answers)
        .expect("harvest the completed review");
    assert_eq!(harvested.base, base);
    assert_eq!(harvested.head, head);
    assert_eq!(harvested.conclusion, "review dispatched");
    assert_eq!(harvested.layers.len(), 3);
    for layer in &harvested.layers {
        assert_eq!(layer.answer, format!("{} reviewed", layer.layer));
    }
    let profile = pa_daemon::big_brother::profile::resolve_profile(&agent_dir, &repo)
        .expect("resolve the repository profile")
        .expect("profile present");

    // Persist one review record before any delivery (ADR 0021) and advance
    // the cursor through the same product boundary.
    let record = ReviewRecord {
        version: 1,
        branch: branch.clone(),
        base: harvested.base,
        head: harvested.head,
        completed_at: String::new(),
        layers: harvested
            .layers
            .into_iter()
            .map(|layer| ReviewRecordLayer {
                model: profile
                    .layer_model(&layer.layer)
                    .expect("profile layer model")
                    .to_string(),
                child: child_ids.get(&layer.layer).cloned(),
                answer: Some(layer.answer),
                layer: layer.layer,
            })
            .collect(),
        conclusion: Some(harvested.conclusion),
        delivery: std::collections::BTreeMap::default(),
    };
    match store.complete(record).expect("complete the range") {
        Completion::Completed {
            range: done,
            record_path,
        } => {
            assert_eq!(done.head, head);
            assert!(record_path.exists());
        }
        other @ Completion::AlreadyComplete { .. } => {
            panic!("expected completion, got {other:?}")
        }
    }
    let state = store.load().expect("state after completion");
    assert_eq!(
        state.branches[&branch].cursor.as_deref(),
        Some(head.as_str())
    );
    assert!(state.branches[&branch].in_flight.is_none());
    // The record reads back through the product query surface.
    let records = store.records(&branch).expect("records");
    assert_eq!(records.len(), 1);
    assert_eq!(records[0].head, head);
    assert_eq!(records[0].layers.len(), 3);
    assert_eq!(records[0].conclusion.as_deref(), Some("review dispatched"));
    // The review ran exactly once; the exact main-model call count varies
    // with child settle notices triggering follow-up turns, so the count
    // is captured here and must not move across the restart below.
    let main_calls_after_review = main_calls.load(Ordering::SeqCst);
    assert!(main_calls_after_review >= 3);
    drop(client);
    drop(restarted);
    std::fs::remove_file(&socket).ok();
    let _second_restart = spawn_daemon(&socket, &agent_dir);
    let (mut client, _) = Client::connect(&socket);
    client.send_command("after-result-restart", &json!({ "type": "list" }));
    assert_eq!(
        client.read_response("after-result-restart")["success"],
        true
    );
    // The durable repository state prevents a second admission for the
    // already-reviewed head: no duplicate wake after another restart.
    assert_eq!(
        store.admit(&branch, &head).expect("re-admission probe"),
        Admission::AlreadyReviewed { head: head.clone() }
    );
    assert_eq!(main_calls.load(Ordering::SeqCst), main_calls_after_review);
}

/// The observer process handle: killed at teardown like the daemon, so a
/// finished test never leaks a scanning process.
struct Observer {
    child: Child,
}

impl Drop for Observer {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

/// Spawn the REAL watch service: the product binary polls the daemon, not
/// the test.
#[allow(clippy::zombie_processes)]
fn spawn_observer(socket: &Path, agent_dir: &Path) -> Observer {
    let child = Command::new(env!("CARGO_BIN_EXE_pa-daemon"))
        .arg("observer")
        .arg("--socket")
        .arg(socket)
        .arg("--agent-dir")
        .arg(agent_dir)
        .arg("--interval-secs")
        .arg("1")
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .expect("spawn the observer");
    Observer { child }
}

/// The acceptance loop with the real observer: a commit lands, the
/// observer admits the range, wakes the conductor, waits for the layers,
/// harvests, and persists the record; a daemon+observer restart recovers
/// and reviews the next range without duplicating the first.
#[test]
fn the_observer_discovers_ranges_completes_records_and_recovers() {
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
    let sessions = agent_dir.join("sessions");
    std::fs::create_dir_all(&sessions).expect("sessions dir");
    let main_calls = Arc::new(AtomicUsize::new(0));
    let url = spawn_review_mock(Arc::clone(&main_calls));
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
    write_review_profile(&agent_dir, &repo);
    let store = RepositoryStateStore::open(&agent_dir, &repo);
    store.seed_cursor(&branch, &base).expect("seed baseline");

    let socket = dir.path().join("daemon.sock");
    let daemon = spawn_daemon(&socket, &agent_dir);
    let (mut client, _) = Client::connect(&socket);
    client.send_command(
        "create",
        &json!({
            "type": "create", "name": "review-main",
            "config": { "cwd": repo, "sessionDir": sessions,
                "bigBrotherReview": true }
        }),
    );
    let created = client.read_response("create");
    assert_eq!(created["success"], true, "{created}");
    let active_id = created["data"]["id"]
        .as_str()
        .or_else(|| created["data"]["activeSessionId"].as_str())
        .expect("active id")
        .to_string();
    client.send_command(
        "bootstrap",
        &json!({
            "type": "prompt_and_wait", "activeSessionId": active_id, "message": "bootstrap"
        }),
    );
    assert_eq!(client.read_response("bootstrap")["success"], true);
    drop(client);

    let observer = spawn_observer(&socket, &agent_dir);

    // A new commit lands while the observer watches.
    std::fs::write(repo.join("code.txt"), "first change\n").expect("first change");
    git(&repo, &["add", "code.txt"]);
    git(&repo, &["commit", "-qm", "first change"]);
    let head1 = git(&repo, &["rev-parse", "HEAD"]);
    let records = wait_until(Duration::from_secs(90), || {
        (store.records(&branch).unwrap().len() == 1).then(|| store.records(&branch).unwrap())
    });
    let record = &records[0];
    assert_eq!(record.base, base);
    assert_eq!(record.head, head1);
    assert_eq!(record.layers.len(), 3);
    assert_eq!(record.conclusion.as_deref(), Some("review dispatched"));
    for layer in &record.layers {
        assert_eq!(
            layer.answer.as_deref(),
            Some(format!("{} reviewed", layer.layer).as_str())
        );
        assert_eq!(
            layer.model,
            format!("prime-inference/{}", layer.layer),
            "the record names each layer's profile model"
        );
        assert!(layer.child.is_some(), "the record names each child");
    }
    let state = store.load().unwrap();
    assert_eq!(
        state.branches[&branch].cursor.as_deref(),
        Some(head1.as_str())
    );

    // Extra scans do not duplicate the review.
    std::thread::sleep(Duration::from_millis(2500));
    assert_eq!(store.records(&branch).unwrap().len(), 1);

    // A daemon + observer restart: the next range reviews normally.
    drop(observer);
    drop(daemon);
    std::fs::remove_file(&socket).ok();
    let _daemon2 = spawn_daemon(&socket, &agent_dir);
    let _observer2 = spawn_observer(&socket, &agent_dir);
    std::fs::write(repo.join("code.txt"), "second change\n").expect("second change");
    git(&repo, &["add", "code.txt"]);
    git(&repo, &["commit", "-qm", "second change"]);
    let head2 = git(&repo, &["rev-parse", "HEAD"]);
    let records = wait_until(Duration::from_secs(90), || {
        (store.records(&branch).unwrap().len() == 2).then(|| store.records(&branch).unwrap())
    });
    // Records sort by head sha, not completion order: match by head.
    let second = records
        .iter()
        .find(|record| record.head == head2)
        .expect("the second range's record");
    assert_eq!(second.base, head1, "the second range continues the cursor");
    assert_eq!(second.layers.len(), 3);
}

#[test]
fn send_to_a_saved_session_after_daemon_restart_wakes_it_and_runs_the_turn() {
    let dir = tempfile::TempDir::new().expect("temp dir");
    let agent_dir = dir.path().join("agent");
    let sessions = agent_dir.join("sessions");
    std::fs::create_dir_all(&sessions).expect("sessions dir");
    let url = spawn_mock("wake reply");
    std::fs::write(
        agent_dir.join("models.json"),
        json!({
            "providers": {
                "prime-inference": {
                    "api": "openai-completions",
                    "baseUrl": url.to_string_lossy(),
                    "apiKey": "sk-wake",
                    "models": [
                        {
                            "id": "mock-1",
                            "name": "Mock 1",
                            "api": "openai-completions",
                            "contextWindow": 128_000,
                            "maxTokens": 4096
                        }
                    ]
                }
            }
        })
        .to_string(),
    )
    .expect("write models.json");
    let socket = dir.path().join("daemon.sock");
    let daemon = spawn_daemon(&socket, &agent_dir);
    let (mut client, hello) = Client::connect(&socket);
    assert_eq!(hello["type"], "daemon_hello");

    client.send_command(
        "c1",
        &json!({
            "type": "create",
            "name": "alpha",
            "config": {
                "cwd": dir.path().to_string_lossy(),
                "sessionDir": sessions.to_string_lossy(),
                "provider": "prime-inference",
                "model": "mock-1",
            },
        }),
    );
    let created = client.read_response("c1");
    assert_eq!(created["success"], true, "create failed: {created}");
    let active_id = created["data"]["id"]
        .as_str()
        .or_else(|| created["data"]["activeSessionId"].as_str())
        .expect("active id")
        .to_string();
    let session_id = created["data"]["sessionId"]
        .as_str()
        .expect("session id")
        .to_string();
    client.send_command(
        "p1",
        &json!({
            "type": "prompt_and_wait",
            "activeSessionId": active_id,
            "message": "first turn",
        }),
    );
    let first_turn = client.read_response("p1");
    assert_eq!(
        first_turn["success"], true,
        "first turn failed: {first_turn}"
    );
    let first_messages = messages(&mut client, "gm1", &active_id);
    assert!(first_messages.contains("wake reply"), "{first_messages}");

    client.send_command(
        "k1",
        &json!({ "type": "kill", "activeSessionId": active_id }),
    );
    assert_eq!(client.read_response("k1")["success"], true, "kill failed");
    client.send_command("l1", &json!({ "type": "list" }));
    let list = client.read_response("l1");
    assert_eq!(
        list["data"]["sessions"].as_array().map(Vec::len),
        Some(0),
        "no live sessions after kill: {list}"
    );
    client.send_command(
        "l2",
        &json!({ "type": "list_saved_sessions", "cwd": dir.path().to_string_lossy() }),
    );
    // The list streams item/progress events before the final response.
    let saved_rows = loop {
        let line = client.read_line();
        let sessions = line["data"]["sessions"].as_array().cloned();
        if line.get("id").and_then(Value::as_str) == Some("l2") {
            if let Some(sessions) = sessions {
                break sessions;
            }
        }
    };
    assert_eq!(saved_rows.len(), 1, "the killed session is saved");
    assert_eq!(saved_rows[0]["name"], "alpha");

    // Simulate a machine restart: the monitor can address the saved session
    // after a new daemon starts, without retaining the old active worker id.
    drop(client);
    drop(daemon);
    std::fs::remove_file(&socket).ok();
    let _restarted_daemon = spawn_daemon(&socket, &agent_dir);
    let (mut client, hello) = Client::connect(&socket);
    assert_eq!(hello["type"], "daemon_hello");
    client.send_command("l-restart", &json!({ "type": "list" }));
    let list = client.read_response("l-restart");
    assert_eq!(list["data"]["sessions"].as_array().map(Vec::len), Some(0));

    client.send_command(
        "s1",
        &json!({ "type": "send_message", "targetActiveSessionId": "alpha", "message": "wake up" }),
    );
    let sent = client.read_response("s1");
    assert_eq!(sent["success"], true, "send by name failed: {sent}");
    let receipt = &sent["data"];
    assert_eq!(receipt["target"]["sessionName"], "alpha", "{receipt}");
    assert_eq!(receipt["deliveryStatus"], "delivered", "{receipt}");
    let woken_id = receipt["target"]["activeSessionId"]
        .as_str()
        .expect("woken active id")
        .to_string();
    assert_ne!(woken_id, active_id, "a new worker hosts the woken session");

    let listed = wait_until(Duration::from_secs(15), || {
        client.send_command("l3", &json!({ "type": "list" }));
        let list = client.read_response("l3");
        list["data"]["sessions"].as_array().and_then(|sessions| {
            sessions
                .iter()
                .find(|summary| summary["sessionId"].as_str() == Some(session_id.as_str()))
                .cloned()
        })
    });
    assert_eq!(listed["sessionName"], "alpha", "{listed}");

    let woken_messages = wait_until(Duration::from_secs(30), || {
        let text = messages(&mut client, "gm2", &woken_id);
        (text.contains("[agent-message from") && text.contains("wake reply")).then_some(text)
    });
    // The delivery renders as the agent_message custom row: the body
    // rides the row content (the rendered prompt) and details.message.
    assert_eq!(
        woken_messages.matches("wake up").count(),
        2,
        "{woken_messages}"
    );

    client.send_command(
        "s2",
        &json!({ "type": "send_message", "targetActiveSessionId": "alpha", "message": "again" }),
    );
    let resent = client.read_response("s2");
    assert_eq!(resent["success"], true, "second send failed: {resent}");
    assert_eq!(
        resent["data"]["target"]["activeSessionId"], woken_id,
        "reuse keeps the same worker: {resent}"
    );
    wait_until(Duration::from_secs(30), || {
        let text = messages(&mut client, "gm3", &woken_id);
        // The second send's card carries the body in the row content and
        // in details.message: two occurrences for the one delivery.
        (text.matches("again").count() == 2).then_some(())
    });

    client.send_command(
        "s3",
        &json!({ "type": "send_message", "targetActiveSessionId": "ghost", "message": "no" }),
    );
    let missed = client.read_response("s3");
    assert_eq!(missed["success"], false, "{missed}");
    assert_eq!(missed["error"], "Unknown active session: ghost");

    // The stopped worker's 12-hex active id is not durable: the catalog
    // keys by session id and name, so it stays unknown (TS parity).
    client.send_command(
        "s4",
        &json!({ "type": "send_message", "targetActiveSessionId": active_id, "message": "no" }),
    );
    let stale = client.read_response("s4");
    assert_eq!(stale["success"], false, "{stale}");
    assert_eq!(
        stale["error"],
        format!("Unknown active session: {active_id}")
    );

    client.send_command(
        "s5",
        &json!({
            "type": "send_message",
            "targetActiveSessionId": &session_id[..8],
            "message": "by id",
        }),
    );
    let by_id = client.read_response("s5");
    assert_eq!(by_id["success"], true, "send by session id failed: {by_id}");
    assert_eq!(
        by_id["data"]["target"]["activeSessionId"], woken_id,
        "the session-id prefix resolved to the resident worker: {by_id}"
    );
}
