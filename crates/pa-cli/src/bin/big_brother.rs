//! The Big Brother product CLI: repository enrollment (`init`, ADR 0022)
//! and the operator query surface (`status`). The command logic lives in
//! `pa-daemon`'s `big_brother` modules; this binary only parses arguments
//! and prints results.

use std::path::PathBuf;

use anyhow::{anyhow, bail, Context as _, Result};

fn main() {
    if let Err(error) = run() {
        eprintln!("big-brother: {error:#}");
        std::process::exit(1);
    }
}

#[tokio::main]
async fn run() -> Result<()> {
    let mut args = std::env::args().skip(1);
    let command = args.next().unwrap_or_else(|| {
        eprintln!("usage: big-brother <init|status> [options]");
        std::process::exit(2);
    });
    match command.as_str() {
        "init" => init_command(args).await,
        "status" => status_command(args),
        other => Err(anyhow!("unknown command: {other} (expected init|status)")),
    }
}

async fn init_command(mut args: std::iter::Skip<std::env::Args>) -> Result<()> {
    let mut repo = None;
    let mut agent_dir = None;
    let mut socket_path = None;
    let mut branch = None;
    let mut session_name = None;
    let mut main_model = None;
    let mut layers = Vec::new();
    let next_value = |flag: &str, args: &mut std::iter::Skip<std::env::Args>| -> Result<String> {
        args.next().ok_or_else(|| anyhow!("--{flag} needs a value"))
    };
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--repo" => repo = Some(PathBuf::from(next_value("repo", &mut args)?)),
            "--agent-dir" => agent_dir = Some(PathBuf::from(next_value("agent-dir", &mut args)?)),
            "--socket" => socket_path = Some(PathBuf::from(next_value("socket", &mut args)?)),
            "--branch" => branch = Some(next_value("branch", &mut args)?),
            "--session-name" => session_name = Some(next_value("session-name", &mut args)?),
            "--main-model" => main_model = Some(next_value("main-model", &mut args)?),
            "--layer" => {
                let value = next_value("layer", &mut args)?;
                let (name, model) = value
                    .split_once('=')
                    .ok_or_else(|| anyhow!("--layer expects name=model, got {value}"))?;
                layers.push((name.to_string(), model.to_string()));
            }
            other => bail!("unknown init option: {other}"),
        }
    }
    let options = pa_daemon::big_brother::init::InitOptions {
        socket_path: socket_path.unwrap_or_else(pa_daemon::socket::default_daemon_socket_path),
        agent_dir: agent_dir.map_or_else(pa_daemon::paths::agent_dir, Ok)?,
        repo: repo.map_or_else(
            || std::env::current_dir().context("reading the current directory"),
            Ok,
        )?,
        branch,
        session_name,
        main_model,
        layers,
    };
    let outcome = pa_daemon::big_brother::init::run_init(options).await?;
    println!(
        "enrolled {} (branch {})",
        outcome.git_root.display(),
        outcome.branch
    );
    println!("  profile:    {}", outcome.profile_path.display());
    println!("  baseline:   {}", outcome.cursor);
    println!(
        "  conductor:  {} ({})",
        outcome.session_name,
        if outcome.created_conductor {
            "created"
        } else {
            "already present"
        }
    );
    println!("  assets:     {}", outcome.assets_dir.display());
    Ok(())
}

fn status_command(mut args: std::iter::Skip<std::env::Args>) -> Result<()> {
    let mut repo = None;
    let mut agent_dir = None;
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--repo" => {
                repo = Some(PathBuf::from(
                    args.next().ok_or_else(|| anyhow!("--repo needs a value"))?,
                ));
            }
            "--agent-dir" => {
                agent_dir = Some(PathBuf::from(
                    args.next()
                        .ok_or_else(|| anyhow!("--agent-dir needs a value"))?,
                ));
            }
            other => bail!("unknown status option: {other}"),
        }
    }
    let options = pa_daemon::big_brother::query::QueryOptions {
        agent_dir: agent_dir.map_or_else(pa_daemon::paths::agent_dir, Ok)?,
        repo: repo.map_or_else(
            || std::env::current_dir().context("reading the current directory"),
            Ok,
        )?,
    };
    let status = pa_daemon::big_brother::query::load_repository_status(&options)?;
    print!("{}", pa_daemon::big_brother::query::render_status(&status));
    Ok(())
}
