//! The durable Repository state of one watched repository (CONTEXT.md
//! "Repository state"): the per-branch review cursor, the single admitted
//! in-flight Review range (ADR 0018), and the completed Review records
//! (ADR 0021 — the record persists before any delivery). Stored at
//! `<agent-dir>/big-brother/repos/<repo-slug>/` beside the review profile,
//! never inside the watched work tree.
//!
//! Writes serialize through a proper-lockfile-compatible directory lock
//! with atomic temp+rename replacement, following the settings storage
//! conventions. The record file lands before the state advance, so a crash
//! between the two replays `complete` idempotently.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use super::profile::repo_dir;

/// The only repository-state schema version this build reads.
pub const STATE_VERSION: u32 = 1;
/// The only review-record schema version this build reads.
const RECORD_VERSION: u32 = 1;
/// Staleness for the repository state lock (the settings default).
const LOCK_STALE_AFTER: std::time::Duration = std::time::Duration::from_secs(10);

/// The durable state of one watched repository: per-branch cursors and
/// in-flight ranges. Completed results live as record files.
#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RepositoryState {
    /// The schema version; anything else is a loud error.
    pub version: u32,
    /// The watched repository's git root, recorded at every write so the
    /// observer can find the persistent work tree from the state alone
    /// (the directory slug does not invert).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub git_root: Option<String>,
    #[serde(default)]
    pub branches: BTreeMap<String, BranchState>,
}

impl Default for RepositoryState {
    fn default() -> Self {
        RepositoryState {
            version: STATE_VERSION,
            git_root: None,
            branches: BTreeMap::new(),
        }
    }
}

/// One tracked branch's review progress.
#[derive(Debug, Clone, Default, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BranchState {
    /// The last completed revision — the next range's base. `None` until
    /// enrollment seeds the baseline.
    #[serde(default)]
    pub cursor: Option<String>,
    /// The single admitted, not-yet-completed range. ADR 0018: a later
    /// head waits until this range completes; it never preempts.
    #[serde(default)]
    pub in_flight: Option<ReviewRange>,
    /// The most recent range that exhausted its attempts (ADR 0028):
    /// `None` until a range fails loudly. The cursor never moved past it,
    /// so a later range re-covers its commits.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_failure: Option<ReviewFailure>,
    #[serde(default)]
    pub updated_at: String,
}

/// One admitted Review range (ADR 0018): immutable once admitted, except
/// its attempt supervision fields (ADR 0028), which advance as timed-out
/// attempts are cancelled and re-armed.
#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReviewRange {
    pub base: String,
    pub head: String,
    #[serde(default)]
    pub admitted_at: String,
    /// The attempts spent so far, the current one included (ADR 0028);
    /// documents from before attempt supervision load as attempt 1.
    #[serde(default = "default_attempts")]
    pub attempts: u32,
    /// When the current attempt started (ADR 0028); empty on legacy
    /// documents, where the admission time is the first attempt's start.
    #[serde(default)]
    pub attempt_started_at: String,
}

/// The pre-supervision attempt count: every legacy in-flight range is on
/// its first attempt.
fn default_attempts() -> u32 {
    1
}

/// A range that exhausted its attempts (ADR 0028): the loud failure the
/// query surface shows, kept beside the branch state — the cursor never
/// moves past an unreviewed change.
#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReviewFailure {
    pub base: String,
    pub head: String,
    pub attempts: u32,
    /// The explicit failure reason (ADR 0017's `timed_out`).
    pub reason: String,
    pub failed_at: String,
}

/// The outcome of admitting an observed head for one branch.
#[derive(Debug, PartialEq)]
pub enum Admission {
    /// A fresh range was admitted and persisted.
    Admitted(ReviewRange),
    /// The head is already the cursor: reviewed, nothing to do.
    AlreadyReviewed { head: String },
    /// The head is already under review: nothing to do.
    InReview { range: ReviewRange },
    /// Another range is in review (ADR 0018); retry after it completes.
    Busy { in_flight: ReviewRange },
}

/// The outcome of completing a range.
#[derive(Debug, PartialEq)]
pub enum Completion {
    /// The record persisted and the cursor advanced to the range head.
    Completed {
        range: ReviewRange,
        record_path: PathBuf,
    },
    /// The range was already complete (an idempotent replay).
    AlreadyComplete { head: String, record_path: PathBuf },
}

/// The durable result of one completed Review range (ADR 0021): the
/// common source for the Operator session and every delivery channel.
#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReviewRecord {
    pub version: u32,
    pub branch: String,
    pub base: String,
    pub head: String,
    /// The attempts this review consumed, the completing one included
    /// (ADR 0028); records from before attempt supervision load as 1.
    #[serde(default = "default_attempts")]
    pub attempts: u32,
    #[serde(default)]
    pub completed_at: String,
    /// The per-layer child results, as dispatched by the review profile.
    #[serde(default)]
    pub layers: Vec<ReviewRecordLayer>,
    /// The main agent's synthesis, when captured.
    #[serde(default)]
    pub conclusion: Option<String>,
    /// Per-channel durable delivery state (ADR 0021/0029). The record
    /// file's existence is the local channel; every enabled channel
    /// appends its own entry here, retrying independently.
    #[serde(default)]
    pub delivery: BTreeMap<String, DeliveryState>,
}

/// One delivery channel's durable state on a record (ADR 0029): how
/// many sends were attempted, when the last one ran, why it failed,
/// and when one succeeded.
#[derive(Debug, Clone, Default, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeliveryState {
    /// Sends attempted for this channel, the current one included.
    pub attempts: u32,
    /// When the last attempt ran (ISO); empty before the first attempt.
    #[serde(default)]
    pub last_attempt_at: String,
    /// Why the last attempt failed; `None` once a send succeeded.
    #[serde(default)]
    pub last_error: Option<String>,
    /// When a send succeeded; `None` while the channel is pending.
    #[serde(default)]
    pub delivered_at: Option<String>,
}

impl DeliveryState {
    /// Whether a send succeeded and the channel is done with this
    /// record.
    #[must_use]
    pub fn delivered(&self) -> bool {
        self.delivered_at.is_some()
    }

    /// Advance a channel's state over one attempt's outcome (ADR
    /// 0029): a send without an error delivers, an error stays pending
    /// with the reason — whatever ran is counted and stamped.
    #[must_use]
    pub fn advance(
        previous: Option<&DeliveryState>,
        now_iso: String,
        error: Option<String>,
    ) -> DeliveryState {
        DeliveryState {
            attempts: previous.map_or(1, |state| state.attempts.saturating_add(1)),
            last_attempt_at: now_iso.clone(),
            delivered_at: error.is_none().then_some(now_iso),
            last_error: error,
        }
    }
}

/// One review layer's child result inside a record.
#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReviewRecordLayer {
    pub layer: String,
    pub model: String,
    #[serde(default)]
    pub child: Option<String>,
    #[serde(default)]
    pub answer: Option<String>,
}

/// A repository-state failure: loud, because silent state loss would
/// re-review or drop ranges without an operator decision.
#[derive(Debug, thiserror::Error)]
pub enum StateError {
    /// The state file exists but cannot be read.
    #[error("repository state at {path} is unreadable: {source}")]
    Unreadable {
        /// The state file that failed to read.
        path: PathBuf,
        /// The underlying I/O error.
        source: std::io::Error,
    },
    /// The state file is not valid JSON for the schema.
    #[error("malformed repository state at {path}: {source}")]
    MalformedState {
        /// The state file that failed to parse.
        path: PathBuf,
        /// The underlying serde error.
        source: serde_json::Error,
    },
    /// A record file is not valid JSON for the schema.
    #[error("malformed review record at {path}: {source}")]
    MalformedRecord {
        /// The record file that failed to parse.
        path: PathBuf,
        /// The underlying serde error.
        source: serde_json::Error,
    },
    /// The stored schema version is not one this build understands.
    #[error("unsupported repository state version {found} (expected {STATE_VERSION})")]
    UnsupportedVersion {
        /// The version found on disk.
        found: u32,
    },
    /// A record file's stored version is not one this build understands.
    #[error("unsupported review record version {found} (expected {RECORD_VERSION})")]
    UnsupportedRecordVersion {
        /// The version found on disk.
        found: u32,
    },
    /// The branch has no seeded cursor; enrollment owns the baseline.
    #[error("branch \"{branch}\" has no seeded cursor; enrollment must set the baseline before a range can be admitted")]
    NotSeeded {
        /// The branch that was asked to admit a range.
        branch: String,
    },
    /// The requested attempt operation targets a range that is not the
    /// branch's in-flight range (ADR 0028).
    #[error("branch \"{branch}\" has no in-flight range at {head}")]
    RangeNotInFlight {
        /// The branch that was asked for an attempt transition.
        branch: String,
        /// The range head that did not match.
        head: String,
    },
    /// The branch's cursor was already seeded to another revision.
    #[error("branch \"{branch}\" cursor is already {cursor}; refusing to reseed to {requested}")]
    Reseed {
        /// The branch that was asked to reseed.
        branch: String,
        /// The current cursor.
        cursor: String,
        /// The rejected replacement.
        requested: String,
    },
    /// A revision does not look like a git object id.
    #[error("revision \"{value}\" is not a git object id (40 or 64 hex characters)")]
    InvalidRevision {
        /// The rejected value.
        value: String,
    },
    /// A completion matched neither the in-flight range nor the cursor.
    #[error("completion for {branch} {base}..{head} matches neither the in-flight range nor the cursor; a stray completion is never silently accepted")]
    StrayCompletion {
        /// The branch of the rejected completion.
        branch: String,
        /// The claimed range base.
        base: String,
        /// The claimed range head.
        head: String,
    },
    /// A record file in one branch's records directory claims another
    /// branch: on-disk corruption, never silently skipped.
    #[error(
        "review record at {path} claims branch \"{branch}\" inside the records of \"{expected}\""
    )]
    RecordBranchMismatch {
        /// The offending record file.
        path: PathBuf,
        /// The branch the record claims.
        branch: String,
        /// The branch whose records were being read.
        expected: String,
    },
    /// A delivery update named a record that does not exist.
    #[error("no review record at {path} to mark delivery on: {source}")]
    RecordMissing {
        /// The record file that should carry the delivery state.
        path: PathBuf,
        /// The underlying I/O error.
        source: std::io::Error,
    },
    /// The state lock could not be acquired.
    #[error("failed to acquire the repository state lock: {0}")]
    Lock(String),
    /// A durable write failed.
    #[error("writing {path} failed: {source}")]
    Write {
        /// The file that failed to write.
        path: PathBuf,
        /// The underlying I/O error.
        source: std::io::Error,
    },
    /// A directory creation failed.
    #[error("creating directory {path} failed: {source}")]
    Directory {
        /// The directory that failed to create.
        path: PathBuf,
        /// The underlying I/O error.
        source: std::io::Error,
    },
}

/// The durable Repository state store of one watched repository.
#[derive(Debug, Clone)]
pub struct RepositoryStateStore {
    repo_dir: PathBuf,
    git_root: PathBuf,
}

impl RepositoryStateStore {
    /// Open the store for the watched repository rooted at `git_root`
    /// (the same repo-keyed directory as the review profile).
    #[must_use]
    pub fn open(agent_dir: &Path, git_root: &Path) -> Self {
        RepositoryStateStore {
            repo_dir: repo_dir(agent_dir, git_root),
            git_root: git_root.to_path_buf(),
        }
    }

    /// The state file path (`<repo-dir>/state.json`).
    #[must_use]
    pub fn state_path(&self) -> PathBuf {
        self.repo_dir.join("state.json")
    }

    /// The watched repository's git root this store was opened for.
    #[must_use]
    pub fn git_root(&self) -> &Path {
        &self.git_root
    }

    /// The completed records of one branch, oldest first.
    ///
    /// # Errors
    ///
    /// A malformed or unsupported record, or an unreadable state directory,
    /// is a loud error — records are the delivery source of truth.
    pub fn records(&self, branch: &str) -> Result<Vec<ReviewRecord>, StateError> {
        let dir = self.records_branch_dir(branch);
        let entries = match std::fs::read_dir(&dir) {
            Ok(entries) => entries,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
            Err(source) => {
                return Err(StateError::Unreadable { path: dir, source });
            }
        };
        let mut paths: Vec<PathBuf> = entries
            .filter_map(std::result::Result::ok)
            .map(|entry| entry.path())
            .filter(|path| {
                path.extension()
                    .is_some_and(|extension| extension == "json")
            })
            .collect();
        paths.sort();
        let mut records = Vec::with_capacity(paths.len());
        for path in paths {
            let bytes = std::fs::read(&path).map_err(|source| StateError::Unreadable {
                path: path.clone(),
                source,
            })?;
            let record: ReviewRecord =
                serde_json::from_slice(&bytes).map_err(|source| StateError::MalformedRecord {
                    path: path.clone(),
                    source,
                })?;
            if record.version != RECORD_VERSION {
                return Err(StateError::UnsupportedRecordVersion {
                    found: record.version,
                });
            }
            if record.branch != branch {
                return Err(StateError::RecordBranchMismatch {
                    path,
                    branch: record.branch,
                    expected: branch.to_string(),
                });
            }
            records.push(record);
        }
        Ok(records)
    }

    /// Read the current state; a missing file is a fresh (empty) state.
    ///
    /// # Errors
    ///
    /// An unreadable, malformed, or unsupported state file is a loud error.
    pub fn load(&self) -> Result<RepositoryState, StateError> {
        self.read_state()
    }

    /// Seed a branch's baseline cursor (enrollment): the first range's
    /// base. Idempotent when re-seeding the same revision; a different
    /// revision is refused — a baseline reset is a deliberate operation,
    /// not a side effect.
    ///
    /// # Errors
    ///
    /// Loud on an invalid revision, a conflicting reseed, or a state I/O
    /// failure.
    pub fn seed_cursor(&self, branch: &str, revision: &str) -> Result<(), StateError> {
        validate_revision(revision)?;
        let lock = self.acquire_lock()?;
        let mut state = self.read_state()?;
        let branch_state = state.branches.entry(branch.to_string()).or_default();
        match (&branch_state.cursor, &branch_state.in_flight) {
            (None, None) => {}
            (Some(current), None) if current == revision => return Ok(()),
            (Some(current), _) => {
                return Err(StateError::Reseed {
                    branch: branch.to_string(),
                    cursor: current.clone(),
                    requested: revision.to_string(),
                });
            }
            (None, Some(_)) => {
                // An in-flight range without a cursor cannot arise through
                // this store's API; refuse rather than guess.
                return Err(StateError::Reseed {
                    branch: branch.to_string(),
                    cursor: "in review".to_string(),
                    requested: revision.to_string(),
                });
            }
        }
        branch_state.cursor = Some(revision.to_string());
        branch_state.updated_at = crate::util::now_iso();
        self.write_state(&state)?;
        drop(lock);
        Ok(())
    }

    /// Admit an observed head as a Review range (ADR 0018). The base is
    /// the branch cursor; a head equal to the cursor or the in-flight
    /// head admits nothing; another in-flight range makes the caller wait.
    ///
    /// # Errors
    ///
    /// Loud on an unseeded branch, an invalid revision, or a state I/O
    /// failure.
    pub fn admit(&self, branch: &str, head: &str) -> Result<Admission, StateError> {
        validate_revision(head)?;
        let lock = self.acquire_lock()?;
        let mut state = self.read_state()?;
        let Some(branch_state) = state.branches.get_mut(branch) else {
            return Err(StateError::NotSeeded {
                branch: branch.to_string(),
            });
        };
        if branch_state.cursor.as_deref() == Some(head) {
            return Ok(Admission::AlreadyReviewed {
                head: head.to_string(),
            });
        }
        if let Some(in_flight) = &branch_state.in_flight {
            if in_flight.head == head {
                return Ok(Admission::InReview {
                    range: in_flight.clone(),
                });
            }
            return Ok(Admission::Busy {
                in_flight: in_flight.clone(),
            });
        }
        let Some(base) = branch_state.cursor.clone() else {
            return Err(StateError::NotSeeded {
                branch: branch.to_string(),
            });
        };
        let range = ReviewRange {
            base,
            head: head.to_string(),
            admitted_at: crate::util::now_iso(),
            attempts: 1,
            attempt_started_at: crate::util::now_iso(),
        };
        branch_state.in_flight = Some(range.clone());
        branch_state.updated_at = crate::util::now_iso();
        self.write_state(&state)?;
        drop(lock);
        Ok(Admission::Admitted(range))
    }

    /// Re-arm the in-flight range after a cancelled attempt (ADR 0028):
    /// the attempt count advances and the new attempt's start stamps now.
    /// A retry is a new attempt with the same input identity — the range
    /// itself never changes.
    ///
    /// # Errors
    ///
    /// Loud when the branch's in-flight range is not this head.
    pub fn retry_attempt(&self, branch: &str, head: &str) -> Result<u32, StateError> {
        let lock = self.acquire_lock()?;
        let mut state = self.read_state()?;
        let branch_state =
            state
                .branches
                .get_mut(branch)
                .ok_or_else(|| StateError::RangeNotInFlight {
                    branch: branch.to_string(),
                    head: head.to_string(),
                })?;
        let in_flight =
            branch_state
                .in_flight
                .as_mut()
                .ok_or_else(|| StateError::RangeNotInFlight {
                    branch: branch.to_string(),
                    head: head.to_string(),
                })?;
        if in_flight.head != head {
            return Err(StateError::RangeNotInFlight {
                branch: branch.to_string(),
                head: head.to_string(),
            });
        }
        in_flight.attempts += 1;
        in_flight.attempt_started_at = crate::util::now_iso();
        let attempts = in_flight.attempts;
        branch_state.updated_at = crate::util::now_iso();
        self.write_state(&state)?;
        drop(lock);
        Ok(attempts)
    }

    /// Fail the in-flight range loudly (ADR 0028): the slot clears, the
    /// failure records on the branch with its attempt count and reason,
    /// and the cursor does not move — an unreviewed change is never
    /// swallowed as reviewed. The next admitted head starts from the same
    /// base, re-covering the failed commits.
    ///
    /// # Errors
    ///
    /// Loud when the branch's in-flight range is not this head.
    pub fn fail_range(&self, branch: &str, head: &str, reason: &str) -> Result<(), StateError> {
        let lock = self.acquire_lock()?;
        let mut state = self.read_state()?;
        let branch_state =
            state
                .branches
                .get_mut(branch)
                .ok_or_else(|| StateError::RangeNotInFlight {
                    branch: branch.to_string(),
                    head: head.to_string(),
                })?;
        let in_flight =
            branch_state
                .in_flight
                .take()
                .ok_or_else(|| StateError::RangeNotInFlight {
                    branch: branch.to_string(),
                    head: head.to_string(),
                })?;
        if in_flight.head != head {
            // Put the range back: this failure targeted the wrong head.
            branch_state.in_flight = Some(in_flight);
            return Err(StateError::RangeNotInFlight {
                branch: branch.to_string(),
                head: head.to_string(),
            });
        }
        branch_state.last_failure = Some(ReviewFailure {
            base: in_flight.base,
            head: in_flight.head,
            attempts: in_flight.attempts,
            reason: reason.to_string(),
            failed_at: crate::util::now_iso(),
        });
        branch_state.updated_at = crate::util::now_iso();
        self.write_state(&state)?;
        drop(lock);
        Ok(())
    }

    /// Complete a range: persist the record (before any delivery, ADR
    /// 0021), then advance the cursor and clear the in-flight slot. An
    /// exact replay after a crash between the two writes is idempotent.
    ///
    /// # Errors
    ///
    /// Loud on a completion matching neither the in-flight range nor the
    /// cursor, an invalid record, or a state I/O failure.
    ///
    /// # Panics
    ///
    /// Panics only on the internal invariant that the matched in-flight
    /// range is still present after the match check above.
    pub fn complete(&self, record: ReviewRecord) -> Result<Completion, StateError> {
        if record.version != RECORD_VERSION {
            return Err(StateError::UnsupportedRecordVersion {
                found: record.version,
            });
        }
        validate_revision(&record.base)?;
        validate_revision(&record.head)?;
        if record.branch.trim().is_empty() {
            return Err(StateError::StrayCompletion {
                branch: record.branch,
                base: record.base,
                head: record.head,
            });
        }
        let lock = self.acquire_lock()?;
        let mut state = self.read_state()?;
        let mut record = record;
        // The store owns the completion timestamp: a caller-supplied time
        // (a replay's original) survives; an empty one is stamped now.
        if record.completed_at.trim().is_empty() {
            record.completed_at = crate::util::now_iso();
        }
        let Some(branch_state) = state.branches.get_mut(&record.branch) else {
            return Err(StateError::StrayCompletion {
                branch: record.branch,
                base: record.base,
                head: record.head,
            });
        };
        let record_path = self
            .records_branch_dir(&record.branch)
            .join(format!("{}.json", record.head));
        let matches_in_flight = branch_state
            .in_flight
            .as_ref()
            .is_some_and(|range| range.base == record.base && range.head == record.head);
        if !matches_in_flight {
            // The only legal replay: the state already advanced past this
            // exact completion (a crash between the record write and the
            // state write replays through the arm above, never here).
            if branch_state.cursor.as_deref() == Some(record.head.as_str()) && record_path.exists()
            {
                return Ok(Completion::AlreadyComplete {
                    head: record.head,
                    record_path,
                });
            }
            return Err(StateError::StrayCompletion {
                branch: record.branch,
                base: record.base,
                head: record.head,
            });
        }
        // The record lands BEFORE the state advance (ADR 0021): a crash
        // here replays `complete` idempotently through the match above.
        if !record_path.exists() {
            std::fs::create_dir_all(record_path.parent().expect("records branch dir")).map_err(
                |source| StateError::Directory {
                    path: record_path
                        .parent()
                        .expect("records branch dir")
                        .to_path_buf(),
                    source,
                },
            )?;
            let body = serde_json::to_string_pretty(&record).map_err(|source| {
                StateError::MalformedRecord {
                    path: record_path.clone(),
                    source,
                }
            })?;
            atomic_write(&record_path, &body)?;
        }
        let range = branch_state.in_flight.clone().expect("matched in flight");
        branch_state.cursor = Some(record.head.clone());
        branch_state.in_flight = None;
        branch_state.updated_at = crate::util::now_iso();
        self.write_state(&state)?;
        drop(lock);
        Ok(Completion::Completed { range, record_path })
    }

    fn records_branch_dir(&self, branch: &str) -> PathBuf {
        self.repo_dir.join("records").join(sanitize_branch(branch))
    }

    /// Record one channel's delivery outcome on a completed record
    /// (ADR 0029). Delivery state is the only part of a record that
    /// mutates after completion; the write takes the same state lock as
    /// `complete` and replaces the file atomically.
    ///
    /// # Errors
    ///
    /// Loud when the record does not exist, claims another branch, or
    /// the read or write fails.
    pub fn update_delivery(
        &self,
        branch: &str,
        head: &str,
        channel: &str,
        state: DeliveryState,
    ) -> Result<(), StateError> {
        let lock = self.acquire_lock()?;
        let record_path = self.records_branch_dir(branch).join(format!("{head}.json"));
        let bytes = std::fs::read(&record_path).map_err(|source| StateError::RecordMissing {
            path: record_path.clone(),
            source,
        })?;
        let mut record: ReviewRecord =
            serde_json::from_slice(&bytes).map_err(|source| StateError::MalformedRecord {
                path: record_path.clone(),
                source,
            })?;
        if record.branch != branch {
            return Err(StateError::RecordBranchMismatch {
                path: record_path,
                branch: record.branch,
                expected: branch.to_string(),
            });
        }
        record.delivery.insert(channel.to_string(), state);
        let body = serde_json::to_string_pretty(&record).map_err(|source| {
            StateError::MalformedRecord {
                path: record_path.clone(),
                source,
            }
        })?;
        atomic_write(&record_path, &body)?;
        drop(lock);
        Ok(())
    }

    fn read_state(&self) -> Result<RepositoryState, StateError> {
        let path = self.state_path();
        let bytes = match std::fs::read(&path) {
            Ok(bytes) => bytes,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                return Ok(RepositoryState::default());
            }
            Err(source) => {
                return Err(StateError::Unreadable { path, source });
            }
        };
        let state: RepositoryState =
            serde_json::from_slice(&bytes).map_err(|source| StateError::MalformedState {
                path: path.clone(),
                source,
            })?;
        if state.version != STATE_VERSION {
            return Err(StateError::UnsupportedVersion {
                found: state.version,
            });
        }
        Ok(state)
    }

    fn write_state(&self, state: &RepositoryState) -> Result<(), StateError> {
        // The store owns the git-root record: every write refreshes it
        // from the store's own construction identity.
        let mut state = state.clone();
        state.git_root = Some(self.git_root.to_string_lossy().into_owned());
        let body =
            serde_json::to_string_pretty(&state).map_err(|source| StateError::MalformedState {
                path: self.state_path(),
                source,
            })?;
        atomic_write(&self.state_path(), &body)
    }

    fn acquire_lock(&self) -> Result<pa_core::platform::lock_dir::LockDir, StateError> {
        // The lock directory's parent is the repo dir: a first-ever write
        // creates it before the lock can live beside the state file.
        std::fs::create_dir_all(&self.repo_dir).map_err(|source| StateError::Directory {
            path: self.repo_dir.clone(),
            source,
        })?;
        // The settings lock protocol: proper-lockfile-compatible dir lock,
        // 10s staleness, brief retry on contention, open failures loud.
        let path = self.state_path();
        let max_attempts = 10;
        let mut last_error: Option<String> = None;
        for _ in 1..=max_attempts {
            match pa_core::platform::lock_dir::LockDir::acquire(&path, LOCK_STALE_AFTER) {
                Ok(guard) => return Ok(guard),
                Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                    if last_error.is_none() {
                        last_error = Some(error.to_string());
                    }
                }
                Err(error) => {
                    return Err(StateError::Lock(error.to_string()));
                }
            }
            std::thread::sleep(std::time::Duration::from_millis(20));
        }
        Err(StateError::Lock(
            last_error.unwrap_or_else(|| "busy".to_string()),
        ))
    }
}

/// A git object id: 40 (SHA-1) or 64 (SHA-256) hex characters.
fn validate_revision(value: &str) -> Result<(), StateError> {
    let valid =
        matches!(value.len(), 40 | 64) && value.bytes().all(|byte| byte.is_ascii_hexdigit());
    if valid {
        Ok(())
    } else {
        Err(StateError::InvalidRevision {
            value: value.to_string(),
        })
    }
}

/// A filesystem-safe directory name for a branch: branch names may carry
/// `/` and other non-alphanumeric characters.
fn sanitize_branch(branch: &str) -> String {
    let mut name = String::new();
    let mut in_separator_run = false;
    for character in branch.chars() {
        if character.is_ascii_alphanumeric() {
            name.push(character);
            in_separator_run = false;
        } else if !in_separator_run {
            name.push('-');
            in_separator_run = true;
        }
    }
    name.trim_matches('-').to_string()
}

/// Atomic temp+rename write (the settings storage convention): the temp
/// file sits beside the target so the rename replaces atomically.
fn atomic_write(path: &Path, content: &str) -> Result<(), StateError> {
    let parent = path.parent().unwrap_or(Path::new("."));
    let file_name = path.file_name().map_or_else(
        || "state".to_string(),
        |name| name.to_string_lossy().into_owned(),
    );
    let temp = parent.join(format!(".{file_name}.tmp"));
    std::fs::write(&temp, content).map_err(|source| StateError::Write {
        path: temp.clone(),
        source,
    })?;
    std::fs::rename(&temp, path).map_err(|source| StateError::Write {
        path: path.to_path_buf(),
        source,
    })?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    const BASE: &str = "0123456789abcdef0123456789abcdef01234567";
    const HEAD: &str = "89abcdef0123456789abcdef0123456789abcdef";
    const NEXT: &str = "fedcba9876543210fedcba9876543210fedcba98";

    fn store() -> (tempfile::TempDir, RepositoryStateStore) {
        let dir = tempfile::TempDir::new().unwrap();
        let git_root = dir.path().join("watched");
        std::fs::create_dir_all(git_root.join(".git")).unwrap();
        let store = RepositoryStateStore::open(&dir.path().join("agent"), &git_root);
        (dir, store)
    }

    fn record_for(branch: &str, base: &str, head: &str) -> ReviewRecord {
        ReviewRecord {
            version: RECORD_VERSION,
            branch: branch.to_string(),
            base: base.to_string(),
            head: head.to_string(),
            attempts: 1,
            completed_at: crate::util::now_iso(),
            layers: vec![ReviewRecordLayer {
                layer: "requirements".to_string(),
                model: "prime-inference/requirements".to_string(),
                child: Some("child-1".to_string()),
                answer: Some("requirements reviewed".to_string()),
            }],
            conclusion: Some("clean".to_string()),
            delivery: BTreeMap::new(),
        }
    }

    fn admit_head(store: &RepositoryStateStore, branch: &str, head: &str) -> ReviewRange {
        match store.admit(branch, head).unwrap() {
            Admission::Admitted(range) => range,
            other => panic!("expected admission, got {other:?}"),
        }
    }

    #[test]
    fn a_fresh_store_loads_an_empty_state() {
        let (_dir, store) = store();
        assert_eq!(store.load().unwrap(), RepositoryState::default());
        assert!(store.records("main").unwrap().is_empty());
    }

    #[test]
    fn admission_requires_a_seeded_cursor() {
        let (_dir, store) = store();
        let error = store.admit("main", HEAD).unwrap_err();
        assert!(error.to_string().contains("no seeded cursor"), "{error}");
        assert!(matches!(
            store.seed_cursor("main", "not-a-sha").unwrap_err(),
            StateError::InvalidRevision { .. }
        ));
    }

    #[test]
    fn seeding_is_idempotent_but_never_conflicting() {
        let (_dir, store) = store();
        store.seed_cursor("main", BASE).unwrap();
        store.seed_cursor("main", BASE).unwrap();
        let error = store.seed_cursor("main", HEAD).unwrap_err();
        assert!(error.to_string().contains("refusing to reseed"), "{error}");
    }

    #[test]
    fn admission_admits_once_then_reports_progress() {
        let (_dir, store) = store();
        store.seed_cursor("main", BASE).unwrap();
        let range = admit_head(&store, "main", HEAD);
        assert_eq!(range.base, BASE);
        assert_eq!(range.head, HEAD);
        // The same head again: in review.
        assert_eq!(
            store.admit("main", HEAD).unwrap(),
            Admission::InReview {
                range: range.clone()
            }
        );
        // A later head while one range is in review: wait (ADR 0018).
        assert_eq!(
            store.admit("main", NEXT).unwrap(),
            Admission::Busy {
                in_flight: range.clone()
            }
        );
        // Progress survives a reopen (a process restart).
        let state = store.load().unwrap();
        assert_eq!(state.branches["main"].in_flight, Some(range));
    }

    #[test]
    fn completion_persists_the_record_then_advances_the_cursor() {
        let (_dir, store) = store();
        store.seed_cursor("main", BASE).unwrap();
        let range = admit_head(&store, "main", HEAD);
        let completion = store
            .complete(record_for("main", &range.base, &range.head))
            .unwrap();
        let Completion::Completed {
            range: done,
            record_path,
        } = completion
        else {
            panic!("expected completion");
        };
        assert_eq!(done.head, HEAD);
        assert!(record_path.exists());
        let state = store.load().unwrap();
        assert_eq!(state.branches["main"].cursor.as_deref(), Some(HEAD));
        assert_eq!(state.branches["main"].in_flight, None);
        // The completed head admits nothing; the next range continues from it.
        assert_eq!(
            store.admit("main", HEAD).unwrap(),
            Admission::AlreadyReviewed {
                head: HEAD.to_string()
            }
        );
        let next = admit_head(&store, "main", NEXT);
        assert_eq!(next.base, HEAD);
        // The record reads back through the query surface.
        let records = store.records("main").unwrap();
        assert_eq!(records.len(), 1);
        assert_eq!(records[0].head, HEAD);
        assert_eq!(records[0].layers.len(), 1);
        assert_eq!(records[0].conclusion.as_deref(), Some("clean"));
    }

    #[test]
    fn a_replayed_completion_after_the_state_advance_is_idempotent() {
        let (_dir, store) = store();
        store.seed_cursor("main", BASE).unwrap();
        let range = admit_head(&store, "main", HEAD);
        store
            .complete(record_for("main", &range.base, &range.head))
            .unwrap();
        let replay = store
            .complete(record_for("main", &range.base, &range.head))
            .unwrap();
        assert!(matches!(replay, Completion::AlreadyComplete { .. }));
        assert_eq!(store.records("main").unwrap().len(), 1);
    }

    #[test]
    fn delivery_state_updates_only_existing_records() {
        let (_dir, store) = store();
        store.seed_cursor("main", BASE).unwrap();
        let range = admit_head(&store, "main", HEAD);
        store
            .complete(record_for("main", &range.base, &range.head))
            .unwrap();
        let pending = DeliveryState::advance(
            None,
            "2026-10-17T00:00:00.000Z".to_string(),
            Some("HTTP 500".to_string()),
        );
        store
            .update_delivery("main", HEAD, "bark", pending.clone())
            .unwrap();
        assert_eq!(
            store.records("main").unwrap()[0].delivery["bark"],
            pending,
            "the failure state round-trips"
        );
        let delivered =
            DeliveryState::advance(Some(&pending), "2026-10-17T00:01:00.000Z".to_string(), None);
        store
            .update_delivery("main", HEAD, "bark", delivered)
            .unwrap();
        let channel = &store.records("main").unwrap()[0].delivery["bark"];
        assert_eq!(channel.attempts, 2);
        assert!(channel.delivered());
        assert_eq!(channel.last_error, None);
        // A delivery update never invents a record, and the completion's
        // other fields are untouched by the channel writes.
        assert!(matches!(
            store.update_delivery("main", NEXT, "bark", channel.clone()),
            Err(StateError::RecordMissing { .. })
        ));
    }

    #[test]
    fn a_stray_completion_is_refused() {
        let (_dir, store) = store();
        store.seed_cursor("main", BASE).unwrap();
        admit_head(&store, "main", HEAD);
        let error = store.complete(record_for("main", BASE, NEXT)).unwrap_err();
        assert!(
            error.to_string().contains("never silently accepted"),
            "{error}"
        );
        // Nothing moved.
        let state = store.load().unwrap();
        assert_eq!(state.branches["main"].cursor.as_deref(), Some(BASE));
        assert!(state.branches["main"].in_flight.is_some());
        assert!(store.records("main").unwrap().is_empty());
    }

    #[test]
    fn branches_are_independent() {
        let (_dir, store) = store();
        store.seed_cursor("main", BASE).unwrap();
        store.seed_cursor("feat/review", BASE).unwrap();
        let main_range = admit_head(&store, "main", HEAD);
        let feat_range = admit_head(&store, "feat/review", HEAD);
        // Two branches hold the same revisions as independent in-flight
        // ranges: completing one leaves the other untouched.
        assert_eq!(main_range.base, feat_range.base);
        assert_eq!(main_range.head, feat_range.head);
        store
            .complete(record_for("main", &main_range.base, &main_range.head))
            .unwrap();
        let state = store.load().unwrap();
        assert_eq!(state.branches["main"].cursor.as_deref(), Some(HEAD));
        assert_eq!(state.branches["feat/review"].cursor.as_deref(), Some(BASE));
        assert!(state.branches["feat/review"].in_flight.is_some());
        // The slashed branch's records land in a sanitized directory and
        // read back with the original branch name.
        store
            .complete(record_for(
                "feat/review",
                &feat_range.base,
                &feat_range.head,
            ))
            .unwrap();
        assert_eq!(store.records("feat/review").unwrap().len(), 1);
    }

    #[test]
    fn an_unsupported_state_version_is_loud() {
        let (dir, store) = store();
        let state_path = crate::big_brother::profile::repo_dir(
            &dir.path().join("agent"),
            &dir.path().join("watched"),
        )
        .join("state.json");
        std::fs::create_dir_all(state_path.parent().unwrap()).unwrap();
        std::fs::write(
            &state_path,
            serde_json::json!({ "version": 2, "branches": {} }).to_string(),
        )
        .unwrap();
        let error = store.load().unwrap_err();
        assert!(
            error
                .to_string()
                .contains("unsupported repository state version"),
            "{error}"
        );
    }

    #[test]
    fn attempt_transitions_advance_and_fail_loudly() {
        let (_dir, store) = store();
        store.seed_cursor("main", BASE).unwrap();
        let range = admit_head(&store, "main", HEAD);
        assert_eq!(range.attempts, 1);
        assert!(!range.attempt_started_at.is_empty());
        // A cancelled attempt re-arms the same range: attempts advance,
        // the range identity does not change.
        assert_eq!(store.retry_attempt("main", HEAD).unwrap(), 2);
        let rearmed = store.load().unwrap().branches["main"].in_flight.clone();
        assert_eq!(
            rearmed,
            Some(ReviewRange {
                attempts: 2,
                attempt_started_at: rearmed.as_ref().unwrap().attempt_started_at.clone(),
                ..range
            })
        );
        // A wrong head never re-arms or fails anything.
        assert!(matches!(
            store.retry_attempt("main", NEXT),
            Err(StateError::RangeNotInFlight { .. })
        ));
        // Exhausting the ceiling fails the range: the slot clears, the
        // cursor stays, the failure records with its count and reason.
        store.fail_range("main", HEAD, "timed_out").unwrap();
        let state = store.load().unwrap();
        let branch = &state.branches["main"];
        assert!(branch.in_flight.is_none());
        assert_eq!(branch.cursor.as_deref(), Some(BASE));
        let failure = branch.last_failure.as_ref().unwrap();
        assert_eq!((failure.base.as_str(), failure.head.as_str()), (BASE, HEAD));
        assert_eq!(failure.attempts, 2);
        assert_eq!(failure.reason, "timed_out");
        // The next head admits from the same base, re-covering the failed
        // commits.
        let next = admit_head(&store, "main", NEXT);
        assert_eq!(next.base, BASE);
        assert!(matches!(
            store.fail_range("main", HEAD, "timed_out"),
            Err(StateError::RangeNotInFlight { .. })
        ));
    }

    #[test]
    fn legacy_documents_load_as_first_attempt() {
        let (dir, store) = store();
        // A pre-supervision state document: no attempt fields anywhere.
        let state_path = crate::big_brother::profile::repo_dir(
            &dir.path().join("agent"),
            &dir.path().join("watched"),
        )
        .join("state.json");
        std::fs::create_dir_all(state_path.parent().unwrap()).unwrap();
        std::fs::write(
            &state_path,
            serde_json::json!({
                "version": 1,
                "branches": { "main": { "cursor": BASE,
                    "inFlight": { "base": BASE, "head": HEAD,
                        "admittedAt": "2026-10-14T00:00:00.000Z" } } }
            })
            .to_string(),
        )
        .unwrap();
        let state = store.load().unwrap();
        let range = state.branches["main"].in_flight.as_ref().unwrap();
        assert_eq!(range.attempts, 1);
        assert_eq!(range.attempt_started_at, "");
        assert_eq!(range.admitted_at, "2026-10-14T00:00:00.000Z");
        // A legacy record also loads with its implicit single attempt.
        let record_dir = state_path.parent().unwrap().join("records").join("main");
        std::fs::create_dir_all(&record_dir).unwrap();
        std::fs::write(
            record_dir.join(format!("{HEAD}.json")),
            serde_json::json!({
                "version": 1, "branch": "main", "base": BASE, "head": HEAD,
                "layers": [], "conclusion": null
            })
            .to_string(),
        )
        .unwrap();
        let records = store.records("main").unwrap();
        assert_eq!(records[0].attempts, 1);
    }
}
