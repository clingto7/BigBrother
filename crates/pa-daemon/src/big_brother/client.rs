//! The daemon-protocol client shared by the Big Brother surfaces: the
//! observer (ADR 0027) and enrollment (ADR 0022) both speak the same wire
//! protocol an operator's client uses, inheriting the daemon's hardened
//! paths instead of growing private back doors.

use std::path::Path;

use anyhow::{anyhow, Context as _, Result};
use pa_types::platform::transport::{connect_transport, AsyncReadHalf, AsyncWriteHalf};
use serde_json::{json, Value};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};

/// Per-request protocol timeout: a stuck daemon fails the caller, never
/// hangs it.
const REQUEST_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(30);

/// A connected daemon protocol client (newline-delimited JSON, protocol
/// version 7). Holds the platform transport's erased halves (a Unix
/// socket, a Windows named pipe) like every other in-crate client.
pub(crate) struct DaemonClient {
    reader: BufReader<Box<dyn AsyncReadHalf>>,
    writer: Box<dyn AsyncWriteHalf>,
    next_id: u64,
}

impl DaemonClient {
    /// Connect and consume the hello line.
    pub(crate) async fn connect(socket_path: &Path) -> Result<Self> {
        let stream = tokio::time::timeout(REQUEST_TIMEOUT, connect_transport(socket_path))
            .await
            .context("timed out connecting to the daemon")?
            .map_err(|error| connection_error_context(socket_path, error))?;
        let (read_half, write_half) = stream.split();
        let mut client = DaemonClient {
            reader: BufReader::new(read_half),
            writer: write_half,
            next_id: 0,
        };
        let _hello = client.read_line().await?;
        Ok(client)
    }

    pub(crate) async fn request(&mut self, command: Value) -> Result<Value> {
        self.next_id += 1;
        let id = format!("big-brother-{}", self.next_id);
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

    /// The session roster (one row per resident session).
    pub(crate) async fn list_sessions(&mut self) -> Result<Vec<Value>> {
        let response = self.request(json!({ "type": "list" })).await?;
        Ok(response["data"]["sessions"]
            .as_array()
            .cloned()
            .unwrap_or_default())
    }

    /// The full roster — resident workers plus saved sessions on disk (the
    /// same facts the saved-session wake resolves): presence checks that
    /// must agree with wake-by-name read this, not the resident-only view.
    pub(crate) async fn list_sessions_including_saved(&mut self) -> Result<Vec<Value>> {
        let response = self.request(json!({ "type": "list", "all": true })).await?;
        Ok(response["data"]["sessions"]
            .as_array()
            .cloned()
            .unwrap_or_default())
    }

    /// One session's transcript (the harvest input, ADR 0026).
    pub(crate) async fn get_messages(&mut self, active_session_id: &str) -> Result<Value> {
        self.request(json!({
            "type": "get_messages", "activeSessionId": active_session_id
        }))
        .await
        .map(|response| response["data"].clone())
    }
}

/// One roster row's session id.
pub(crate) fn session_id(row: &Value) -> Result<String> {
    row.get("id")
        .or_else(|| row.get("activeSessionId"))
        .and_then(Value::as_str)
        .map(str::to_string)
        .ok_or_else(|| anyhow!("roster row carries no session id: {row}"))
}

/// The connect failure's context: a refused connection against an
/// existing socket file is the signature of a dead supervisor's leftover
/// (the next supervisor start cleans it up) — a bare "Connection refused"
/// never says which of "wrong path" and "dead daemon" the operator is
/// looking at.
fn connection_error_context(socket_path: &Path, error: anyhow::Error) -> anyhow::Error {
    let mut context = format!("connecting to daemon socket {}", socket_path.display());
    if error.to_string().to_ascii_lowercase().contains("refused")
        && std::fs::symlink_metadata(socket_path).is_ok()
    {
        context.push_str(
            " — the socket file exists but nothing is listening; it may be left over from a \
             dead supervisor (the next supervisor start cleans it up); is the supervisor running?",
        );
    }
    error.context(context)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A refused connect against a leftover socket file (a bound listener
    /// dropped without unlinking) names the stale file, so an operator can
    /// tell a dead daemon's leftover from a wrong path.
    #[tokio::test]
    async fn a_refused_connect_against_a_stale_socket_file_names_the_leftover() {
        let dir = tempfile::TempDir::new().expect("temp dir");
        let socket = dir.path().join("stale.sock");
        let listener = std::os::unix::net::UnixListener::bind(&socket).expect("bind");
        drop(listener); // the file outlives the listener: the stale shape
        let error = match DaemonClient::connect(&socket).await {
            Ok(_) => panic!("a stale socket file must refuse the connect"),
            Err(error) => error,
        };
        let rendered = format!("{error:#}");
        assert!(
            rendered.contains("left over from a dead supervisor"),
            "the stale file is named:\n{rendered}"
        );
    }

    #[tokio::test]
    async fn a_missing_socket_never_claims_a_leftover() {
        let dir = tempfile::TempDir::new().expect("temp dir");
        let socket = dir.path().join("absent.sock");
        let error = match DaemonClient::connect(&socket).await {
            Ok(_) => panic!("an absent socket path must fail the connect"),
            Err(error) => error,
        };
        let rendered = format!("{error:#}");
        assert!(
            !rendered.contains("left over"),
            "an absent path is not a leftover:\n{rendered}"
        );
    }
}
