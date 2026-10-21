//! The operator query surface: a read-only view of one enrolled
//! repository's durable state — per-branch review cursors, in-flight
//! ranges, and completed review records (ADR 0025). Reads never touch the
//! daemon; the repository-keyed directory under the agent dir is the
//! source of truth.

use std::fmt::Write as _;
use std::path::PathBuf;

use anyhow::{anyhow, Result};

use crate::big_brother::state::{
    ObservationFailure, RepositoryStateStore, ReviewFailure, ReviewRange, ReviewRecord,
};

/// The query command's runtime options.
#[derive(Debug, Clone)]
pub struct QueryOptions {
    /// The agent dir holding `big-brother/repos/`.
    pub agent_dir: PathBuf,
    /// The directory to resolve the watched repository from (normally the
    /// operator's current directory inside the persistent work tree).
    pub repo: PathBuf,
}

/// One tracked branch's review progress and results.
#[derive(Debug, Clone, PartialEq)]
pub struct BranchStatus {
    /// The branch name as recorded in the repository state.
    pub name: String,
    /// The last completed revision; the next range's base.
    pub cursor: Option<String>,
    /// The admitted, not-yet-completed range (ADR 0018).
    pub in_flight: Option<ReviewRange>,
    /// The most recent range that exhausted its attempts (ADR 0028).
    pub last_failure: Option<ReviewFailure>,
    /// The last refusal to fetch or advance the review worktree.
    pub last_observation_failure: Option<ObservationFailure>,
    /// The completed review records, oldest first.
    pub records: Vec<ReviewRecord>,
}

/// One enrolled repository's status.
#[derive(Debug, Clone, PartialEq)]
pub struct RepositoryStatus {
    /// The watched repository's git root.
    pub git_root: PathBuf,
    /// The tracked branches, in the state's (sorted) order.
    pub branches: Vec<BranchStatus>,
}

/// Load one repository's status from its durable state.
///
/// # Errors
///
/// Loud when the directory is not a git repository, the repository has no
/// enrolled state (run `big-brother init` first), or any state or record
/// document is unreadable, malformed, or unsupported.
pub fn load_repository_status(options: &QueryOptions) -> Result<RepositoryStatus> {
    let git_root = pa_core::packages::find_git_repo_root(&options.repo)
        .ok_or_else(|| anyhow!("{} is not inside a git repository", options.repo.display()))?;
    let store = RepositoryStateStore::open(&options.agent_dir, &git_root);
    let state = store
        .load()
        .map_err(|error| anyhow!("repository state: {error}"))?;
    if state.branches.is_empty() {
        anyhow::bail!(
            "the repository at {} has no review state at {}; run big-brother init first",
            git_root.display(),
            store.state_path().display()
        );
    }
    let mut branches = Vec::with_capacity(state.branches.len());
    for (name, branch_state) in state.branches {
        let records = store
            .records(&name)
            .map_err(|error| anyhow!("review records of {name}: {error}"))?;
        branches.push(BranchStatus {
            name,
            cursor: branch_state.cursor,
            in_flight: branch_state.in_flight,
            last_failure: branch_state.last_failure,
            last_observation_failure: branch_state.last_observation_failure,
            records,
        });
    }
    Ok(RepositoryStatus { git_root, branches })
}

/// Render one repository's status as the operator-facing text.
#[must_use]
pub fn render_status(status: &RepositoryStatus) -> String {
    let mut rendered = format!("repository: {}\n", status.git_root.display());
    for branch in &status.branches {
        writeln!(rendered, "branch {}:", branch.name).expect("write to String");
        let cursor = match &branch.cursor {
            Some(cursor) => format!("reviewed through {}", short_revision(cursor)),
            None => "no review baseline yet".to_string(),
        };
        writeln!(rendered, "  {cursor}").expect("write to String");
        let in_flight = match &branch.in_flight {
            Some(range) => format!(
                "review in flight: {}..{} (attempt {})",
                short_revision(&range.base),
                short_revision(&range.head),
                range.attempts
            ),
            None => "no review in flight".to_string(),
        };
        writeln!(rendered, "  {in_flight}").expect("write to String");
        if let Some(failure) = &branch.last_failure {
            writeln!(
                rendered,
                "  last review failed: {}..{} after {} attempt(s) ({}) at {}; a later range re-covers it",
                short_revision(&failure.base),
                short_revision(&failure.head),
                failure.attempts,
                failure.reason,
                failure.failed_at
            )
            .expect("write to String");
        }
        if let Some(failure) = &branch.last_observation_failure {
            writeln!(
                rendered,
                "  worktree update skipped: {} ({}) at {}",
                failure.kind, failure.message, failure.observed_at
            )
            .expect("write to String");
        }
        if branch.records.is_empty() {
            writeln!(rendered, "  no completed reviews").expect("write to String");
        } else {
            writeln!(rendered, "  {} completed review(s):", branch.records.len())
                .expect("write to String");
            for record in &branch.records {
                let conclusion = record
                    .conclusion
                    .as_deref()
                    .map_or("(no synthesis captured)".to_string(), first_line);
                writeln!(
                    rendered,
                    "    {}  {}  {}",
                    short_revision(&record.head),
                    record.completed_at,
                    conclusion
                )
                .expect("write to String");
                if !record.delivery.is_empty() {
                    writeln!(rendered, "      delivery: {}", render_delivery(record))
                        .expect("write to String");
                }
            }
        }
    }
    rendered
}

/// A readable revision prefix: long enough to identify, short enough to
/// scan.
fn short_revision(revision: &str) -> String {
    let prefix: String = revision.chars().take(12).collect();
    if revision.chars().count() > 12 {
        format!("{prefix}…")
    } else {
        prefix
    }
}

/// The first line of a synthesis, capped for one-row display.
fn first_line(text: &str) -> String {
    let line = text
        .lines()
        .find(|line| !line.trim().is_empty())
        .unwrap_or("");
    let capped: String = line.chars().take(72).collect();
    if line.chars().count() > 72 {
        format!("{capped}…")
    } else {
        capped
    }
}

/// One record's per-channel delivery state (ADR 0029): what is
/// delivered, what is still pending with its attempt count and last
/// error.
fn render_delivery(record: &ReviewRecord) -> String {
    record
        .delivery
        .iter()
        .map(|(channel, state)| {
            if state.delivered() {
                format!("{channel} delivered")
            } else if let Some(error) = &state.last_error {
                format!(
                    "{channel} pending (attempt {}, last error: {})",
                    state.attempts,
                    first_line(error)
                )
            } else {
                format!("{channel} pending (attempt {})", state.attempts)
            }
        })
        .collect::<Vec<_>>()
        .join(", ")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::big_brother::state::{Admission, DeliveryState, ReviewRecordLayer};
    use std::collections::BTreeMap;

    const BASE: &str = "0123456789abcdef0123456789abcdef01234567";
    const HEAD: &str = "89abcdef0123456789abcdef0123456789abcdef";

    fn enrolled_repo() -> (tempfile::TempDir, PathBuf, PathBuf, RepositoryStateStore) {
        let dir = tempfile::TempDir::new().unwrap();
        let git_root = dir.path().join("watched");
        std::fs::create_dir_all(git_root.join(".git")).unwrap();
        let agent_dir = dir.path().join("agent");
        let store = RepositoryStateStore::open(&agent_dir, &git_root);
        store.seed_cursor("main", BASE).unwrap();
        (dir, agent_dir, git_root, store)
    }

    fn record(head: &str) -> ReviewRecord {
        ReviewRecord {
            version: 1,
            branch: "main".to_string(),
            base: BASE.to_string(),
            head: head.to_string(),
            attempts: 1,
            completed_at: "2026-10-14T00:00:00Z".to_string(),
            layers: vec![ReviewRecordLayer {
                layer: "requirements".to_string(),
                model: "p/requirements".to_string(),
                child: None,
                answer: Some("reviewed".to_string()),
            }],
            conclusion: Some("clean range\nno violations".to_string()),
            delivery: BTreeMap::new(),
        }
    }

    #[test]
    fn an_unenrolled_repository_names_the_next_step() {
        let dir = tempfile::TempDir::new().unwrap();
        let git_root = dir.path().join("watched");
        std::fs::create_dir_all(git_root.join(".git")).unwrap();
        let options = QueryOptions {
            agent_dir: dir.path().join("agent"),
            repo: git_root,
        };
        let error = load_repository_status(&options).unwrap_err();
        assert!(error.to_string().contains("big-brother init"), "{error}");
    }

    #[test]
    fn status_carries_cursor_in_flight_and_records() {
        let (_dir, agent_dir, git_root, store) = enrolled_repo();
        match store.admit("main", HEAD).unwrap() {
            Admission::Admitted(range) => {
                let mut completed = record(HEAD);
                completed.base = range.base;
                store.complete(completed).unwrap();
            }
            other => panic!("expected admission, got {other:?}"),
        }
        let options = QueryOptions {
            agent_dir,
            repo: git_root.clone(),
        };
        let status = load_repository_status(&options).unwrap();
        assert_eq!(status.git_root, git_root);
        assert_eq!(status.branches.len(), 1);
        let branch = &status.branches[0];
        assert_eq!(branch.name, "main");
        assert_eq!(branch.cursor.as_deref(), Some(HEAD));
        assert_eq!(branch.in_flight, None);
        assert_eq!(branch.records.len(), 1);
        assert_eq!(
            branch.records[0].conclusion.as_deref(),
            Some("clean range\nno violations")
        );
    }

    #[test]
    fn render_shows_short_revisions_and_first_synthesis_line() {
        let (_dir, _agent_dir, git_root, store) = enrolled_repo();
        match store.admit("main", HEAD).unwrap() {
            Admission::Admitted(range) => {
                let mut completed = record(HEAD);
                completed.base = range.base;
                store.complete(completed).unwrap();
            }
            other => panic!("expected admission, got {other:?}"),
        }
        let status = RepositoryStatus {
            git_root,
            branches: store
                .load()
                .unwrap()
                .branches
                .into_iter()
                .map(|(name, branch_state)| BranchStatus {
                    records: store.records(&name).unwrap(),
                    last_failure: Some(ReviewFailure {
                        base: BASE.to_string(),
                        head: "aaaabbbbccccddddaaaabbbbccccddddaaaabbbb".to_string(),
                        attempts: 2,
                        reason: "timed_out".to_string(),
                        failed_at: "2026-10-14T00:00:00Z".to_string(),
                    }),
                    name,
                    cursor: branch_state.cursor,
                    in_flight: branch_state.in_flight,
                    last_observation_failure: branch_state.last_observation_failure,
                })
                .collect(),
        };
        let text = render_status(&status);
        assert!(text.contains("branch main:"), "{text}");
        assert!(text.contains("reviewed through 89abcdef0123…"), "{text}");
        assert!(text.contains("1 completed review(s)"), "{text}");
        assert!(text.contains("clean range"), "{text}");
        assert!(
            text.contains("last review failed: 0123456789ab") && text.contains("..aaaabbbbcccc"),
            "{text}"
        );
        assert!(text.contains("after 2 attempt(s) (timed_out)"), "{text}");
        assert!(
            !text.contains("no violations"),
            "only the synthesis first line renders: {text}"
        );
    }

    #[test]
    fn delivery_state_renders_per_channel() {
        let (_dir, agent_dir, git_root, store) = enrolled_repo();
        match store.admit("main", HEAD).unwrap() {
            Admission::Admitted(range) => {
                let mut completed = record(HEAD);
                completed.base = range.base;
                store.complete(completed).unwrap();
            }
            other => panic!("expected admission, got {other:?}"),
        }
        let mut delivered =
            DeliveryState::advance(None, "2026-10-17T00:00:00.000Z".to_string(), None);
        delivered.delivered_at = Some("2026-10-17T00:00:01.000Z".to_string());
        store
            .update_delivery("main", HEAD, "commit-status", delivered)
            .unwrap();
        let error_text = "bark POST returned 500 Internal Server Error: upstream down";
        store
            .update_delivery(
                "main",
                HEAD,
                "bark",
                DeliveryState::advance(
                    None,
                    "2026-10-17T00:00:00.000Z".to_string(),
                    Some(error_text.to_string()),
                ),
            )
            .unwrap();
        let status = load_repository_status(&QueryOptions {
            agent_dir,
            repo: git_root,
        })
        .unwrap();
        let text = render_status(&status);
        // The map renders in its (sorted) channel order.
        assert!(
            text.contains(&format!(
                "delivery: bark pending (attempt 1, last error: {}), commit-status delivered",
                first_line(error_text)
            )),
            "{text}"
        );
    }

    #[test]
    fn short_revision_and_first_line_helpers_cap_their_output() {
        assert_eq!(short_revision(BASE), "0123456789ab…");
        assert_eq!(short_revision("short"), "short");
        assert_eq!(first_line("lead\nsecond"), "lead");
        assert_eq!(first_line("lead"), "lead");
        assert_eq!(first_line(""), "");
        let long = "x".repeat(80);
        assert_eq!(first_line(&long).chars().count(), 73);
    }
}
