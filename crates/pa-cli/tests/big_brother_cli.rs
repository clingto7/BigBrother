//! The `big-brother` binary's wiring: `status` renders an enrolled
//! repository's durable state, and `init` fails fast (nothing written)
//! when the daemon is unreachable.

use std::collections::BTreeMap;
use std::path::PathBuf;
use std::process::Command;

use pa_daemon::big_brother::state::{
    Admission, RepositoryStateStore, ReviewRecord, ReviewRecordLayer,
};

const BASE: &str = "0123456789abcdef0123456789abcdef01234567";
const HEAD: &str = "89abcdef0123456789abcdef0123456789abcdef";

fn run_big_brother(args: &[&str]) -> std::process::Output {
    Command::new(env!("CARGO_BIN_EXE_big-brother"))
        .args(args)
        .output()
        .expect("run big-brother")
}

/// A fake watched repository (`.git` marker only — status reads no git
/// facts) with one completed review range.
fn enrolled_repository() -> (tempfile::TempDir, PathBuf, PathBuf) {
    let dir = tempfile::TempDir::new().expect("temp dir");
    let repo = dir.path().join("watched");
    std::fs::create_dir_all(repo.join(".git")).expect("git marker");
    let agent_dir = dir.path().join("agent");
    let store = RepositoryStateStore::open(&agent_dir, &repo);
    store.seed_cursor("main", BASE).expect("seed");
    let Admission::Admitted(range) = store.admit("main", HEAD).expect("admit") else {
        panic!("expected admission");
    };
    store
        .complete(ReviewRecord {
            version: 1,
            branch: "main".to_string(),
            base: range.base,
            head: HEAD.to_string(),
            completed_at: String::new(),
            layers: vec![ReviewRecordLayer {
                layer: "requirements".to_string(),
                model: "p/requirements".to_string(),
                child: None,
                answer: Some("reviewed".to_string()),
            }],
            conclusion: Some("clean range".to_string()),
            delivery: BTreeMap::new(),
        })
        .expect("complete");
    (dir, agent_dir, repo)
}

fn real_git_repository() -> (tempfile::TempDir, PathBuf) {
    let dir = tempfile::TempDir::new().expect("temp dir");
    let repo = dir.path().join("repo");
    std::fs::create_dir_all(&repo).expect("repo dir");
    // A throwaway test repository may set its own commit identity
    // (AGENTS.md); the machine's repos must not.
    std::fs::write(repo.join("file.txt"), "baseline\n").expect("baseline file");
    for args in [
        vec!["init", "-q"],
        vec!["add", "file.txt"],
        vec!["commit", "-qm", "baseline"],
    ] {
        let output = Command::new("git")
            .arg("-C")
            .arg(&repo)
            .args(&args)
            .env("GIT_AUTHOR_NAME", "Test")
            .env("GIT_AUTHOR_EMAIL", "test@example.invalid")
            .env("GIT_COMMITTER_NAME", "Test")
            .env("GIT_COMMITTER_EMAIL", "test@example.invalid")
            .output()
            .expect("run git");
        assert!(
            output.status.success(),
            "git {args:?} failed: {}",
            String::from_utf8_lossy(&output.stderr)
        );
    }
    (dir, repo)
}

#[test]
fn status_renders_the_durable_state() {
    let (_dir, agent_dir, repo) = enrolled_repository();
    let output = run_big_brother(&[
        "status",
        "--repo",
        repo.to_str().expect("UTF-8 path"),
        "--agent-dir",
        agent_dir.to_str().expect("UTF-8 path"),
    ]);
    assert!(
        output.status.success(),
        "status failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    let stdout = String::from_utf8(output.stdout).expect("UTF-8 stdout");
    assert!(stdout.contains("branch main:"), "{stdout}");
    assert!(
        stdout.contains("reviewed through 89abcdef0123…"),
        "{stdout}"
    );
    assert!(stdout.contains("1 completed review(s)"), "{stdout}");
    assert!(stdout.contains("clean range"), "{stdout}");
}

#[test]
fn status_names_init_for_an_unenrolled_repository() {
    let (_dir, agent_dir, repo) = enrolled_repository();
    let other = repo.parent().unwrap().join("other");
    std::fs::create_dir_all(other.join(".git")).expect("git marker");
    let output = run_big_brother(&[
        "status",
        "--repo",
        other.to_str().expect("UTF-8 path"),
        "--agent-dir",
        agent_dir.to_str().expect("UTF-8 path"),
    ]);
    assert!(!output.status.success());
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(stderr.contains("big-brother init"), "{stderr}");
}

#[test]
fn init_fails_fast_when_the_daemon_is_unreachable() {
    let (dir, repo) = real_git_repository();
    let agent_dir = dir.path().join("agent");
    let socket = dir.path().join("missing.sock");
    let output = run_big_brother(&[
        "init",
        "--repo",
        repo.to_str().expect("UTF-8 path"),
        "--agent-dir",
        agent_dir.to_str().expect("UTF-8 path"),
        "--socket",
        socket.to_str().expect("UTF-8 path"),
        "--main-model",
        "prime-inference/main",
    ]);
    assert!(
        !output.status.success(),
        "init must fail without a daemon: {}",
        String::from_utf8_lossy(&output.stdout)
    );
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(stderr.contains("supervisor"), "{stderr}");
    // Fail-fast: nothing was half-written.
    assert!(!pa_daemon::big_brother::profile::profile_path(&agent_dir, &repo).is_file());
    assert!(!agent_dir.join("big-brother").exists());
    assert!(!repo.join(".big-brother").exists());
}
