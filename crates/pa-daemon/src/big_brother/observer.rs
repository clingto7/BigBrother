//! The Big Brother watch service: a daemon-protocol client that
//! periodically observes enrolled repositories' tracked branches, admits
//! new Review ranges (ADR 0018/0025), wakes the repository's review
//! conductor by name, and completes the durable record from the settled
//! conversation (ADR 0026) — collecting each layer's full answer from the
//! settled child. Recovery is state-driven: an in-flight range found at
//! startup either harvests from an already-settled conversation or gets
//! its wake retried (a retry is a new attempt with the same input
//! identity).

use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};
use std::time::Duration;

use anyhow::{anyhow, Context as _, Result};
use serde_json::{json, Value};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};

use crate::big_brother::harvest::{harvest_review, last_assistant_text};
use crate::big_brother::profile::ReviewProfile;
use crate::big_brother::state::{
    Admission, RepositoryState, RepositoryStateStore, ReviewRange, ReviewRecord, ReviewRecordLayer,
    STATE_VERSION,
};

/// Per-request protocol timeout: a stuck daemon fails the scan, never the
/// observer.
const REQUEST_TIMEOUT: Duration = Duration::from_secs(30);

/// The watch service's runtime options.
#[derive(Debug, Clone)]
pub struct ObserverOptions {
    /// The daemon's supervisor socket.
    pub socket_path: PathBuf,
    /// The agent dir holding `big-brother/repos/`.
    pub agent_dir: PathBuf,
    /// The scan interval.
    pub interval: Duration,
    /// Run exactly one scan and exit (deployment probes and tests).
    pub once: bool,
}

/// Run the watch service: scan, sleep, repeat. Scan failures are logged
/// and retried on the next interval — observation outlives any one
/// daemon restart.
///
/// # Errors
///
/// Returns only an unrecoverable startup failure; scan-level errors are
/// logged.
pub async fn run_observer(options: ObserverOptions) -> Result<()> {
    // Wakes this observer process has issued (session, head): a
    // non-resident in-flight session is re-woken at most once per run.
    let mut woken: BTreeSet<(String, String)> = BTreeSet::new();
    loop {
        if let Err(error) = scan_once(&options, &mut woken).await {
            eprintln!("big-brother observer: scan failed: {error:#}");
        }
        if options.once {
            return Ok(());
        }
        tokio::time::sleep(options.interval).await;
    }
}

/// One observation pass over every enrolled repository.
async fn scan_once(
    options: &ObserverOptions,
    woken: &mut BTreeSet<(String, String)>,
) -> Result<()> {
    let repos_root = options.agent_dir.join("big-brother").join("repos");
    let entries = std::fs::read_dir(&repos_root)
        .with_context(|| format!("reading enrolled repositories at {}", repos_root.display()))?;
    let mut client: Option<DaemonClient> = None;
    for entry in entries {
        let Ok(entry) = entry else { continue };
        let repo_dir = entry.path();
        if !repo_dir.join("state.json").is_file() {
            continue;
        }
        let result = observe_repo(&mut client, &options.socket_path, &repo_dir, woken).await;
        if let Err(error) = result {
            eprintln!(
                "big-brother observer: repository {} failed: {error:#}",
                repo_dir.display()
            );
        }
    }
    drop(client);
    Ok(())
}

/// Observe one enrolled repository: complete any in-flight range, then
/// admit and wake for a newly observed head.
async fn observe_repo(
    client: &mut Option<DaemonClient>,
    socket_path: &Path,
    repo_dir: &Path,
    woken: &mut BTreeSet<(String, String)>,
) -> Result<()> {
    let state: RepositoryState = read_state(repo_dir)?;
    let Some(git_root) = state.git_root.clone() else {
        return Err(anyhow!(
            "the state records no git root (written by a pre-observer build); re-enroll to record it"
        ));
    };
    let git_root = PathBuf::from(git_root);
    let Some(profile) = resolve_profile_from_repo_dir(repo_dir)? else {
        return Err(anyhow!("no review profile beside the repository state"));
    };
    let store = RepositoryStateStore::open(&store_agent_dir(repo_dir), &git_root);
    // The slug must round-trip: a moved work tree would otherwise write
    // state into a different repository's directory.
    anyhow::ensure!(
        store.state_path().parent() == Some(repo_dir),
        "the state's git root {} does not key this enrolled directory; re-enroll the repository",
        store.git_root().display()
    );
    let client = ensure_client(client, socket_path).await?;

    // An in-flight range completes before a newer head admits (ADR 0018).
    for (branch, branch_state) in &state.branches {
        let Some(in_flight) = branch_state.in_flight.clone() else {
            continue;
        };
        let completed =
            try_complete_review(client, &store, &profile, branch, &in_flight, woken).await?;
        if !completed {
            return Ok(());
        }
    }

    // Observe: the persistent work tree's local branch head. GitHub-side
    // fetching is a later delivery-source concern.
    let state = store.load()?;
    for branch in state.branches.keys() {
        let head = branch_head(&git_root, branch)?;
        match store.admit(branch, &head)? {
            Admission::Admitted(range) => {
                eprintln!(
                    "big-brother observer: admitted {}..{head} on {branch}",
                    range.base
                );
                wake_conductor(client, &profile.session_name, &range).await?;
                woken.insert((profile.session_name.clone(), head));
            }
            Admission::AlreadyReviewed { .. }
            | Admission::InReview { .. }
            | Admission::Busy { .. } => {}
        }
    }
    Ok(())
}

/// Try to complete the in-flight range: collect the layers' answers from
/// the settled children, harvest the conductor's transcript, and persist
/// the record. `Ok(false)` means the review has not settled yet — the
/// next scan retries.
async fn try_complete_review(
    client: &mut DaemonClient,
    store: &RepositoryStateStore,
    profile: &ReviewProfile,
    branch: &str,
    in_flight: &ReviewRange,
    woken: &mut BTreeSet<(String, String)>,
) -> Result<bool> {
    let sessions = client.list_sessions().await?;
    let Some(conductor) = sessions
        .iter()
        .find(|row| row.get("sessionName").and_then(Value::as_str) == Some(&profile.session_name))
    else {
        // The conductor is not resident (a daemon restart before or
        // during the review). A wake this process has not yet issued is
        // the retry; one it has means the turn is still spinning up.
        if woken.insert((profile.session_name.clone(), in_flight.head.clone())) {
            eprintln!(
                "big-brother observer: re-waking {} for a recovered in-flight range",
                profile.session_name
            );
            wake_conductor(client, &profile.session_name, in_flight).await?;
        }
        return Ok(false);
    };
    let conductor_id = session_id(conductor)?;
    // Every configured layer's child must exist and have answered.
    let mut answers: BTreeMap<String, String> = BTreeMap::new();
    let mut child_ids: BTreeMap<String, String> = BTreeMap::new();
    for layer in &profile.layers {
        // The dispatch names each layer's child `<layer>-<head>`: the
        // exact in-flight head discriminates this range's reviewer from
        // the previous range's retained child.
        let child_name = format!("{}-{}", layer.name, in_flight.head);
        let Some(child) = sessions.iter().find(|row| {
            row.get("sessionName").and_then(Value::as_str) == Some(child_name.as_str())
        }) else {
            return Ok(false);
        };
        let child_id = session_id(child)?;
        let messages = client.get_messages(&child_id).await?;
        let Some(answer) = last_assistant_text(&messages) else {
            return Ok(false);
        };
        answers.insert(layer.name.clone(), answer);
        child_ids.insert(layer.name.clone(), child_id);
    }
    let transcript = client.get_messages(&conductor_id).await?;
    // A harvest miss means the conversation has not settled yet.
    let Ok(harvested) = harvest_review(&transcript, &answers) else {
        return Ok(false);
    };
    if harvested.base != in_flight.base || harvested.head != in_flight.head {
        return Err(anyhow!(
            "the conductor's transcript reviews {}..{} but the admitted range is {}..{}",
            harvested.base,
            harvested.head,
            in_flight.base,
            in_flight.head
        ));
    }
    let record = ReviewRecord {
        version: 1,
        branch: branch.to_string(),
        base: harvested.base,
        head: harvested.head,
        completed_at: String::new(),
        layers: harvested
            .layers
            .into_iter()
            .map(|layer| ReviewRecordLayer {
                model: profile
                    .layer_model(&layer.layer)
                    .unwrap_or_default()
                    .to_string(),
                child: child_ids.get(&layer.layer).cloned(),
                answer: Some(layer.answer),
                layer: layer.layer,
            })
            .collect(),
        conclusion: Some(harvested.conclusion),
        delivery: BTreeMap::new(),
    };
    store.complete(record)?;
    woken.remove(&(profile.session_name.clone(), in_flight.head.clone()));
    eprintln!(
        "big-brother observer: completed review of {}..{} on {branch}",
        in_flight.base, in_flight.head
    );
    Ok(true)
}

/// Wake (or message) the review conductor for one admitted range.
async fn wake_conductor(
    client: &mut DaemonClient,
    session_name: &str,
    range: &ReviewRange,
) -> Result<()> {
    client
        .request(json!({
            "type": "send_message",
            "targetActiveSessionId": session_name,
            "message": format!("REVIEW_RANGE {}..{} END", range.base, range.head),
        }))
        .await
        .context("waking the review conductor")?;
    Ok(())
}

/// The tracked branch's head in the persistent work tree.
fn branch_head(git_root: &Path, branch: &str) -> Result<String> {
    let output = std::process::Command::new("git")
        .arg("-C")
        .arg(git_root)
        .arg("rev-parse")
        .arg(branch)
        .output()
        .with_context(|| format!("running git rev-parse in {}", git_root.display()))?;
    if !output.status.success() {
        anyhow::bail!(
            "git rev-parse {branch}: {}",
            String::from_utf8_lossy(&output.stderr)
        );
    }
    Ok(String::from_utf8(output.stdout)?.trim().to_string())
}

/// The repository state off disk (same document the store writes).
fn read_state(repo_dir: &Path) -> Result<RepositoryState> {
    let bytes = std::fs::read(repo_dir.join("state.json"))
        .with_context(|| format!("reading {}", repo_dir.join("state.json").display()))?;
    let state: RepositoryState = serde_json::from_slice(&bytes)
        .with_context(|| format!("parsing {}", repo_dir.join("state.json").display()))?;
    if state.version != STATE_VERSION {
        anyhow::bail!(
            "unsupported repository state version {} (expected {STATE_VERSION})",
            state.version
        );
    }
    Ok(state)
}

/// The profile beside the state (the repository-keyed directory layout).
fn resolve_profile_from_repo_dir(repo_dir: &Path) -> Result<Option<ReviewProfile>> {
    // The profile loader keys by the git root, which the observer learns
    // from the state — read the file beside it directly instead.
    let path = repo_dir.join("profile.json");
    let bytes = match std::fs::read(&path) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error).with_context(|| format!("reading {}", path.display())),
    };
    let profile: ReviewProfile =
        serde_json::from_slice(&bytes).with_context(|| format!("parsing {}", path.display()))?;
    Ok(Some(profile))
}

/// The agent dir owning a repo-keyed directory: `<agent>/big-brother/
/// repos/<slug>` -> `<agent>` (four path components up from the file).
fn store_agent_dir(repo_dir: &Path) -> PathBuf {
    repo_dir
        .ancestors()
        .nth(3)
        .map_or_else(|| PathBuf::from("."), Path::to_path_buf)
}

/// One roster row's session id.
fn session_id(row: &Value) -> Result<String> {
    row.get("id")
        .or_else(|| row.get("activeSessionId"))
        .and_then(Value::as_str)
        .map(str::to_string)
        .ok_or_else(|| anyhow!("roster row carries no session id: {row}"))
}

/// A lazily-connected daemon protocol client, shared across one scan.
struct DaemonClient {
    reader: BufReader<tokio::net::unix::OwnedReadHalf>,
    writer: tokio::net::unix::OwnedWriteHalf,
    next_id: u64,
}

impl DaemonClient {
    /// Connect and consume the hello line.
    async fn connect(socket_path: &Path) -> Result<Self> {
        let stream = tokio::time::timeout(
            REQUEST_TIMEOUT,
            tokio::net::UnixStream::connect(socket_path),
        )
        .await
        .context("timed out connecting to the daemon")?
        .with_context(|| format!("connecting to daemon socket {}", socket_path.display()))?;
        let (read_half, write_half) = stream.into_split();
        let mut client = DaemonClient {
            reader: BufReader::new(read_half),
            writer: write_half,
            next_id: 0,
        };
        let _hello = client.read_line().await?;
        Ok(client)
    }

    async fn request(&mut self, command: Value) -> Result<Value> {
        self.next_id += 1;
        let id = format!("observer-{}", self.next_id);
        let envelope = json!({
            "type": "command",
            "id": id,
            "protocol": { "name": "prime-agent.daemon", "version": 7 },
            "command": command,
        });
        let mut line = serde_json::to_string(&envelope)?;
        line.push('\n');
        tokio::time::timeout(REQUEST_TIMEOUT, self.writer.write_all(line.as_bytes()))
            .await
            .context("timed out sending a daemon command")?
            .context("sending a daemon command")?;
        self.writer
            .flush()
            .await
            .context("flushing a daemon command")?;
        tokio::time::timeout(REQUEST_TIMEOUT, async {
            loop {
                let response = self.read_line().await?;
                if response.get("id").and_then(Value::as_str) == Some(id.as_str()) {
                    if response.get("success") != Some(&Value::Bool(true)) {
                        anyhow::bail!("daemon command failed: {response}");
                    }
                    return Ok(response);
                }
            }
        })
        .await
        .context("timed out waiting for the daemon")?
    }

    async fn read_line(&mut self) -> Result<Value> {
        let mut line = String::new();
        tokio::time::timeout(REQUEST_TIMEOUT, self.reader.read_line(&mut line))
            .await
            .context("timed out reading a daemon line")?
            .context("the daemon closed the connection")?;
        serde_json::from_str(line.trim()).context("parsing a daemon line")
    }

    async fn list_sessions(&mut self) -> Result<Vec<Value>> {
        let response = self.request(json!({ "type": "list" })).await?;
        Ok(response["data"]["sessions"]
            .as_array()
            .cloned()
            .unwrap_or_default())
    }

    async fn get_messages(&mut self, active_session_id: &str) -> Result<Value> {
        self.request(json!({
            "type": "get_messages", "activeSessionId": active_session_id
        }))
        .await
        .map(|response| response["data"].clone())
    }
}

/// Connect the shared scan client if needed.
async fn ensure_client<'a>(
    client: &'a mut Option<DaemonClient>,
    socket_path: &Path,
) -> Result<&'a mut DaemonClient> {
    if client.is_none() {
        *client = Some(DaemonClient::connect(socket_path).await?);
    }
    Ok(client.as_mut().expect("just connected"))
}
