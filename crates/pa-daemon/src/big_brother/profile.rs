//! The per-repository review profile: the operator-owned configuration
//! that selects the restricted review session, its stable wake name, and
//! the review-layer child models (ADR 0019/0024). Stored at
//! `<agent-dir>/big-brother/repos/<repo-slug>/profile.json` inside the
//! repository-keyed directory it shares with the durable repository
//! state (ADR 0025), keyed by the watched repository's local git root.

use std::path::{Path, PathBuf};

/// The only profile schema version this build reads.
pub(crate) const PROFILE_VERSION: u32 = 1;

/// The review profile of one watched repository.
#[derive(Debug, Clone, PartialEq, serde::Deserialize, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReviewProfile {
    /// The schema version; anything else is a loud error, never a
    /// silent downgrade to a normal session.
    pub version: u32,
    /// The stable name the background observer wakes the main review
    /// session by (ADR 0023's saved-session wake contract).
    pub session_name: String,
    /// The model the main review session is created with; the persisted
    /// session model restores from the session file on a cold wake, so
    /// this field matters at creation time (enrollment/init).
    #[serde(default)]
    pub main_model: Option<String>,
    /// The review layers (ADR 0019): each a distinct child-agent role
    /// with its own model, dispatched per review range.
    pub layers: Vec<ReviewLayer>,
    /// One attempt's total time budget in seconds (ADR 0028); `None` is
    /// the default (1800). A stalled conversation is cancelled and
    /// re-attempted when the budget expires — never waited on forever.
    #[serde(default)]
    pub attempt_timeout_seconds: Option<u32>,
    /// The attempt ceiling for one range (ADR 0028, first attempt
    /// included); `None` is the default (3). At the ceiling the range
    /// fails loudly instead of retrying.
    #[serde(default)]
    pub max_attempts: Option<u32>,
}

/// The default attempt budget (ADR 0028): 30 minutes.
const DEFAULT_ATTEMPT_TIMEOUT_SECONDS: u32 = 1800;
/// The default attempt ceiling (ADR 0028): the first attempt plus two
/// retries.
const DEFAULT_MAX_ATTEMPTS: u32 = 3;

/// One review layer's child configuration.
#[derive(Debug, Clone, PartialEq, serde::Deserialize, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReviewLayer {
    /// The layer's stable name (the dispatch argument the main agent
    /// uses and the child session's name).
    pub name: String,
    /// The child's model selector (`provider/model`, short form, or
    /// parent reference — resolved and allowlisted at spawn).
    pub model: String,
}

/// A present-but-unusable profile: loud, because a review session that
/// silently downgrades to normal tools would widen the tool boundary
/// without an operator decision.
#[derive(Debug, thiserror::Error)]
pub enum ProfileError {
    /// The profile's schema version is not one this build understands.
    #[error("unsupported review profile version {found} (expected {PROFILE_VERSION})")]
    UnsupportedVersion { found: u32 },
    /// The profile parsed but violates the schema's invariants.
    #[error("invalid review profile at {path}: {reason}")]
    Invalid { path: PathBuf, reason: String },
    /// The profile file exists but cannot be read.
    #[error("unreadable review profile at {path}: {source}")]
    Unreadable {
        /// The profile file that failed to read.
        path: PathBuf,
        /// The underlying I/O error.
        source: std::io::Error,
    },
    /// The profile file is not valid JSON for the schema.
    #[error("malformed review profile at {path}: {source}")]
    Malformed {
        /// The profile file that failed to parse.
        path: PathBuf,
        /// The underlying serde error.
        source: serde_json::Error,
    },
}

impl ReviewProfile {
    /// The configured model selector for a review layer.
    #[must_use]
    pub fn layer_model(&self, layer: &str) -> Option<&str> {
        self.layers
            .iter()
            .find(|candidate| candidate.name == layer)
            .map(|candidate| candidate.model.as_str())
    }

    /// One attempt's total time budget (ADR 0028).
    #[must_use]
    pub fn attempt_timeout(&self) -> std::time::Duration {
        std::time::Duration::from_secs(u64::from(
            self.attempt_timeout_seconds
                .unwrap_or(DEFAULT_ATTEMPT_TIMEOUT_SECONDS),
        ))
    }

    /// The attempt ceiling for one range, first attempt included (ADR
    /// 0028).
    #[must_use]
    pub fn max_attempts(&self) -> u32 {
        self.max_attempts.unwrap_or(DEFAULT_MAX_ATTEMPTS)
    }

    /// Validate the schema invariants: known version, a non-empty wake
    /// name, and at least one uniquely named layer whose names and model
    /// selectors are non-empty.
    ///
    /// # Errors
    ///
    /// Returns the matching [`ProfileError`] for the first violation.
    pub(crate) fn validate(&self, path: &Path) -> Result<(), ProfileError> {
        let invalid = |reason: String| ProfileError::Invalid {
            path: path.to_path_buf(),
            reason,
        };
        if self.version != PROFILE_VERSION {
            return Err(ProfileError::UnsupportedVersion {
                found: self.version,
            });
        }
        if self.session_name.trim().is_empty() {
            return Err(invalid("sessionName must not be empty".to_string()));
        }
        if self.layers.is_empty() {
            return Err(invalid(
                "layers must contain at least one review layer".to_string(),
            ));
        }
        if self.attempt_timeout_seconds == Some(0) {
            return Err(invalid(
                "attemptTimeoutSeconds must be greater than zero".to_string(),
            ));
        }
        if self.max_attempts == Some(0) {
            return Err(invalid("maxAttempts must be at least 1".to_string()));
        }
        let mut seen = std::collections::BTreeSet::new();
        for layer in &self.layers {
            if layer.name.trim().is_empty() {
                return Err(invalid("layer names must not be empty".to_string()));
            }
            if !seen.insert(layer.name.clone()) {
                return Err(invalid(format!(
                    "duplicate review layer \"{}\"",
                    layer.name
                )));
            }
            if layer.model.trim().is_empty() {
                return Err(invalid(format!(
                    "review layer \"{}\" must name a model",
                    layer.name
                )));
            }
        }
        Ok(())
    }
}

/// The repository-keyed directory under the agent dir:
/// `<agent>/big-brother/repos/<slug>/` — the review profile, the durable
/// repository state, and the review records (ADR 0025).
pub(crate) fn repo_dir(agent_dir: &Path, git_root: &Path) -> PathBuf {
    agent_dir
        .join("big-brother")
        .join("repos")
        .join(repo_slug(git_root))
}

/// The profile file path for a watched repository rooted at `git_root`.
#[must_use]
pub fn profile_path(agent_dir: &Path, git_root: &Path) -> PathBuf {
    repo_dir(agent_dir, git_root).join("profile.json")
}

/// A stable directory slug for a watched repository's git root: the
/// absolute path with every non-alphanumeric run collapsed to one `-`.
/// The first deployment is one operator on one machine with persistent
/// working trees (ADR 0022), so the local path is the repository
/// identity; a hosting-independent key arrives with hosted deployment.
fn repo_slug(git_root: &Path) -> String {
    let mut slug = String::new();
    let mut in_separator_run = false;
    for character in git_root.to_string_lossy().chars() {
        if character.is_ascii_alphanumeric() {
            slug.push(character.to_ascii_lowercase());
            in_separator_run = false;
        } else if !in_separator_run {
            slug.push('-');
            in_separator_run = true;
        }
    }
    slug.trim_matches('-').to_string()
}

/// Resolve the review profile for a session working directory: walk to
/// the git root, then read that repository's profile file.
///
/// # Errors
///
/// Returns `Ok(None)` when the directory is outside a git repository or
/// the repository has no profile file. A present-but-unusable profile is
/// an error (see [`ProfileError`]) — never a silent downgrade.
pub fn resolve_profile(
    agent_dir: &Path,
    cwd: &Path,
) -> Result<Option<ReviewProfile>, ProfileError> {
    let Some(git_root) = pa_core::packages::find_git_repo_root(cwd) else {
        return Ok(None);
    };
    load_profile_at(&profile_path(agent_dir, &git_root))
}

/// Read and validate the profile at `path`; `Ok(None)` when absent.
fn load_profile_at(path: &Path) -> Result<Option<ReviewProfile>, ProfileError> {
    let bytes = match std::fs::read(path) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(source) => {
            return Err(ProfileError::Unreadable {
                path: path.to_path_buf(),
                source,
            })
        }
    };
    let profile: ReviewProfile =
        serde_json::from_slice(&bytes).map_err(|source| ProfileError::Malformed {
            path: path.to_path_buf(),
            source,
        })?;
    profile.validate(path)?;
    Ok(Some(profile))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn write_profile(agent_dir: &Path, git_root: &Path, body: &str) -> PathBuf {
        let path = profile_path(agent_dir, git_root);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(&path, body).unwrap();
        path
    }

    fn valid_profile_body() -> String {
        serde_json::json!({
            "version": 1,
            "sessionName": "review-main",
            "mainModel": "prime-inference/main",
            "layers": [
                { "name": "requirements", "model": "prime-inference/requirements" },
                { "name": "project-fit", "model": "prime-inference/project-fit" },
                { "name": "implementation", "model": "prime-inference/implementation" }
            ]
        })
        .to_string()
    }

    fn temp_repo() -> (tempfile::TempDir, PathBuf) {
        let dir = tempfile::TempDir::new().unwrap();
        let git_root = dir.path().join("watched");
        std::fs::create_dir_all(git_root.join(".git")).unwrap();
        (dir, git_root)
    }

    #[test]
    fn repo_slug_collapses_non_alphanumeric_runs() {
        assert_eq!(
            repo_slug(Path::new("/Users/m1zu/ws/watched repo")),
            "users-m1zu-ws-watched-repo"
        );
        assert_eq!(repo_slug(Path::new("/a//b")), "a-b");
        assert_eq!(repo_slug(Path::new("/UPPER")), "upper");
    }

    #[test]
    fn resolve_returns_none_outside_a_git_repository() {
        let dir = tempfile::TempDir::new().unwrap();
        assert!(resolve_profile(&dir.path().join("agent"), dir.path())
            .unwrap()
            .is_none());
    }

    #[test]
    fn resolve_reads_the_profile_from_the_git_root_key() {
        let (dir, git_root) = temp_repo();
        let agent_dir = dir.path().join("agent");
        write_profile(&agent_dir, &git_root, &valid_profile_body());

        let profile = resolve_profile(&agent_dir, &git_root.join("nested").join("deep"))
            .unwrap()
            .expect("profile found through the git-root walk");
        assert_eq!(profile.version, 1);
        assert_eq!(profile.session_name, "review-main");
        assert_eq!(
            profile.layer_model("project-fit"),
            Some("prime-inference/project-fit")
        );
        assert_eq!(profile.layer_model("unknown"), None);
    }

    #[test]
    fn an_absent_profile_is_none_a_present_one_is_required() {
        let (dir, git_root) = temp_repo();
        let agent_dir = dir.path().join("agent");
        assert!(resolve_profile(&agent_dir, &git_root).unwrap().is_none());
        // A different repository's profile never leaks: the slug keys the
        // exact git root.
        let other_root = dir.path().join("other");
        std::fs::create_dir_all(other_root.join(".git")).unwrap();
        write_profile(&agent_dir, &other_root, &valid_profile_body());
        assert!(resolve_profile(&agent_dir, &git_root).unwrap().is_none());
    }

    #[test]
    fn an_unknown_version_is_a_loud_error() {
        let (dir, git_root) = temp_repo();
        let agent_dir = dir.path().join("agent");
        let body = serde_json::json!({
            "version": 2, "sessionName": "s", "layers": [{ "name": "l", "model": "m" }]
        })
        .to_string();
        write_profile(&agent_dir, &git_root, &body);
        let error = resolve_profile(&agent_dir, &git_root).unwrap_err();
        assert!(
            error
                .to_string()
                .contains("unsupported review profile version"),
            "{error}"
        );
    }

    #[test]
    fn schema_violations_are_loud_errors() {
        let (dir, git_root) = temp_repo();
        let agent_dir = dir.path().join("agent");
        for (reason, body) in [
            (
                "sessionName",
                serde_json::json!({
                    "version": 1, "sessionName": "  ", "layers": [{ "name": "l", "model": "m" }]
                }),
            ),
            (
                "layers",
                serde_json::json!({
                    "version": 1, "sessionName": "s", "layers": []
                }),
            ),
            (
                "duplicate",
                serde_json::json!({
                    "version": 1, "sessionName": "s",
                    "layers": [{ "name": "l", "model": "m" }, { "name": "l", "model": "m" }]
                }),
            ),
            (
                "must name a model",
                serde_json::json!({
                    "version": 1, "sessionName": "s", "layers": [{ "name": "l", "model": " " }]
                }),
            ),
        ] {
            write_profile(&agent_dir, &git_root, &body.to_string());
            let error = resolve_profile(&agent_dir, &git_root).unwrap_err();
            assert!(
                error.to_string().contains(reason),
                "expected \"{reason}\" in: {error}"
            );
        }
    }

    #[test]
    fn malformed_json_is_a_loud_error() {
        let (dir, git_root) = temp_repo();
        let agent_dir = dir.path().join("agent");
        write_profile(&agent_dir, &git_root, "{ not json");
        let error = resolve_profile(&agent_dir, &git_root).unwrap_err();
        assert!(
            error.to_string().contains("malformed review profile"),
            "{error}"
        );
    }

    #[test]
    fn attempt_supervision_defaults_and_overrides() {
        let (dir, git_root) = temp_repo();
        let agent_dir = dir.path().join("agent");
        write_profile(&agent_dir, &git_root, &valid_profile_body());
        let defaults = resolve_profile(&agent_dir, &git_root)
            .unwrap()
            .expect("profile");
        assert_eq!(
            defaults.attempt_timeout(),
            std::time::Duration::from_mins(30)
        );
        assert_eq!(defaults.max_attempts(), 3);
        let body = serde_json::json!({
            "version": 1, "sessionName": "s",
            "attemptTimeoutSeconds": 5, "maxAttempts": 1,
            "layers": [{ "name": "l", "model": "m" }]
        })
        .to_string();
        write_profile(&agent_dir, &git_root, &body);
        let tuned = resolve_profile(&agent_dir, &git_root)
            .unwrap()
            .expect("profile");
        assert_eq!(tuned.attempt_timeout(), std::time::Duration::from_secs(5));
        assert_eq!(tuned.max_attempts(), 1);
        // Zero values are loud, not silent defaults.
        for (field, zeroed) in [
            (
                "attemptTimeoutSeconds",
                serde_json::json!({
                    "version": 1, "sessionName": "s", "attemptTimeoutSeconds": 0,
                    "layers": [{ "name": "l", "model": "m" }]
                }),
            ),
            (
                "maxAttempts",
                serde_json::json!({
                    "version": 1, "sessionName": "s", "maxAttempts": 0,
                    "layers": [{ "name": "l", "model": "m" }]
                }),
            ),
        ] {
            write_profile(&agent_dir, &git_root, &zeroed.to_string());
            let error = resolve_profile(&agent_dir, &git_root).unwrap_err();
            assert!(
                error.to_string().contains(field),
                "expected {field} violation in: {error}"
            );
        }
    }
}
