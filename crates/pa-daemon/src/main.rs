//! `pa-daemon`: supervisor and session-worker binary.

use std::path::PathBuf;

use anyhow::{anyhow, Result};

#[tokio::main]
async fn main() -> Result<()> {
    // Same allocator cap as the prime-agent binary: large transient phases
    // (session loads, attach snapshots) must not leave per-arena high-water
    // pages resident.
    pa_types::memory_release::cap_thread_arenas();
    let mut args = std::env::args().skip(1);
    let command = args.next().unwrap_or_else(|| {
        eprintln!("usage: pa-daemon <supervisor|worker> [options]");
        std::process::exit(2);
    });
    match command.as_str() {
        "supervisor" => {
            let mut socket_path = None;
            let mut agent_dir = None;
            let mut args = args.peekable();
            while let Some(arg) = args.next() {
                match arg.as_str() {
                    "--socket" => socket_path = args.next().map(PathBuf::from),
                    "--agent-dir" => agent_dir = args.next().map(PathBuf::from),
                    other => return Err(anyhow!("unknown supervisor option: {other}")),
                }
            }
            let agent_dir = match agent_dir {
                Some(dir) => dir,
                None => pa_daemon::paths::agent_dir()?,
            };
            let options = pa_daemon::supervisor::SupervisorOptions {
                socket_path: socket_path
                    .unwrap_or_else(pa_daemon::socket::default_daemon_socket_path),
                agent_dir,
            };
            pa_daemon::supervisor::run_supervisor(options).await
        }
        "worker" => pa_daemon::worker::run_worker().await,
        "observer" => {
            let mut socket_path = None;
            let mut agent_dir = None;
            let mut interval_secs = 30u64;
            let mut once = false;
            let mut args = args.peekable();
            while let Some(arg) = args.next() {
                match arg.as_str() {
                    "--socket" => socket_path = args.next().map(PathBuf::from),
                    "--agent-dir" => agent_dir = args.next().map(PathBuf::from),
                    "--interval-secs" => {
                        let value = args
                            .next()
                            .ok_or_else(|| anyhow!("--interval-secs needs a value"))?;
                        interval_secs = value
                            .parse()
                            .map_err(|_| anyhow!("invalid --interval-secs: {value}"))?;
                    }
                    "--once" => once = true,
                    other => return Err(anyhow!("unknown observer option: {other}")),
                }
            }
            let agent_dir = match agent_dir {
                Some(dir) => dir,
                None => pa_daemon::paths::agent_dir()?,
            };
            let options = pa_daemon::big_brother::observer::ObserverOptions {
                socket_path: socket_path
                    .unwrap_or_else(pa_daemon::socket::default_daemon_socket_path),
                agent_dir,
                interval: std::time::Duration::from_secs(interval_secs.max(1)),
                once,
            };
            pa_daemon::big_brother::observer::run_observer(options).await
        }
        other => Err(anyhow!(
            "unknown command: {other} (expected supervisor|worker|observer)"
        )),
    }
}
