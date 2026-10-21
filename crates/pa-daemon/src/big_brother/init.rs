//! Repository initialization (ADR 0022's `big-brother init`): the one
//! command an operator runs in the persistent work tree to enroll a
//! repository. It writes (or validates) the review profile (ADR 0024),
//! seeds the tracked branch's baseline cursor (ADR 0025), creates the
//! review conductor session through the daemon protocol with the
//! `bigBrotherReview` marker, and lays down the minimal `.big-brother`
//! project-understanding assets. Every step is idempotent at the same
//! inputs; a conflicting reseed or an invalid profile stays a loud error.

use std::path::{Path, PathBuf};

use anyhow::{anyhow, bail, Context as _, Result};
use serde_json::json;

use crate::big_brother::client::DaemonClient;
use crate::big_brother::git;
use crate::big_brother::profile::{self, ReviewLayer, ReviewProfile};
use crate::big_brother::state::RepositoryStateStore;

/// The canonical review layers of the initial review scope (CONTEXT.md
/// "Review layer"): verifiable requirements, project fit, implementation
/// quality. A fresh profile starts from these unless the operator assigns
/// layers explicitly.
const DEFAULT_LAYERS: [&str; 3] = ["requirements", "project-fit", "implementation"];

/// The enrollment command's runtime options.
#[derive(Debug, Clone)]
pub struct InitOptions {
    /// The daemon's supervisor socket: the conductor is created through
    /// the daemon protocol, like every observer interaction (ADR 0027).
    pub socket_path: PathBuf,
    /// The agent dir holding `big-brother/repos/`.
    pub agent_dir: PathBuf,
    /// The directory to resolve the watched repository from (normally the
    /// operator's current directory inside the persistent work tree).
    pub repo: PathBuf,
    /// The tracked branch; defaults to `origin/HEAD`, then `main`, then
    /// `master`, with the current branch as a local-only fallback.
    pub branch: Option<String>,
    /// The conductor's stable wake name; defaults to
    /// `review-<repository-directory-name>`.
    pub session_name: Option<String>,
    /// The conductor's creation model. Required when init writes a fresh
    /// profile; a present profile already owns it.
    pub main_model: Option<String>,
    /// Explicit layer assignments (`name=model`): each replaces the
    /// same-named default layer or appends a new one.
    pub layers: Vec<(String, String)>,
    /// One attempt's time budget in seconds (ADR 0028) written into a
    /// fresh profile; a present profile already owns it.
    pub attempt_timeout_seconds: Option<u32>,
    /// The attempt ceiling for one range (ADR 0028) written into a fresh
    /// profile; a present profile already owns it.
    pub max_attempts: Option<u32>,
}

/// What one enrollment run established.
#[derive(Debug, Clone, PartialEq)]
pub struct InitOutcome {
    /// The watched repository's git root.
    pub git_root: PathBuf,
    /// The tracked branch the baseline was seeded for.
    pub branch: String,
    /// The seeded baseline revision (the next range's base).
    pub cursor: String,
    /// The conductor's wake name.
    pub session_name: String,
    /// Whether this run created the conductor (`false` when a session with
    /// the wake name was already on the roster).
    pub created_conductor: bool,
    /// The profile file the repository reviews through.
    pub profile_path: PathBuf,
    /// The `.big-brother` assets directory inside the work tree.
    pub assets_dir: PathBuf,
}

/// Enroll one repository (ADR 0022). See the module docs for the steps.
///
/// # Errors
///
/// Loud on every refusal: no git repository, a detached HEAD without
/// `--branch`, a missing profile and no `--main-model`, an invalid
/// profile, a conflicting cursor reseed, or an unreachable daemon.
pub async fn run_init(options: InitOptions) -> Result<InitOutcome> {
    let git_root = pa_core::packages::find_git_repo_root(&options.repo).ok_or_else(|| {
        anyhow!(
            "{} is not inside a git repository; run big-brother init in the repository's persistent work tree",
            options.repo.display()
        )
    })?;
    let branch = match &options.branch {
        Some(branch) => branch.clone(),
        None => git::default_branch(&git_root)?.or(git::current_branch(&git_root)?).ok_or_else(
            || {
                anyhow!(
                    "the work tree at {} has no default, main, or master branch; pass --branch to name the tracked branch",
                    git_root.display()
                )
            },
        )?,
    };
    let head = git::branch_head(&git_root, &branch)
        .with_context(|| format!("reading the tracked branch {branch}"))?;

    // Connect before any write: an unreachable daemon fails enrollment with
    // nothing half-written.
    let mut client = DaemonClient::connect(&options.socket_path)
        .await
        .with_context(|| {
            format!(
                "connecting to the daemon at {}; is the supervisor running?",
                options.socket_path.display()
            )
        })?;

    let (profile, profile_path) = ensure_profile(&options, &git_root)?;

    // Baseline cursor: idempotent at the same revision, refused at another
    // (ADR 0025 — a baseline reset is a deliberate operation, not a
    // side effect of re-running init).
    let store = RepositoryStateStore::open(&options.agent_dir, &git_root);
    store
        .seed_cursor(&branch, &head)
        .map_err(|error| anyhow!("seeding the review cursor: {error}"))?;

    // Conductor: created through the daemon protocol carrying the review
    // marker (ADR 0024); a roster hit by wake name means an earlier
    // enrollment already created it, and init never creates a second one.
    let sessions = client.list_sessions().await?;
    let created_conductor = !sessions.iter().any(|row| {
        row.get("sessionName").and_then(|value| value.as_str())
            == Some(profile.session_name.as_str())
    });
    if created_conductor {
        client
            .request(json!({
                "type": "create",
                "name": profile.session_name,
                "config": { "cwd": git_root, "bigBrotherReview": true },
            }))
            .await
            .context("creating the review conductor session")?;
    }

    let assets_dir = write_minimal_assets(&git_root, &branch, &head, &profile, &profile_path)?;

    Ok(InitOutcome {
        git_root,
        branch,
        cursor: head,
        session_name: profile.session_name,
        created_conductor,
        profile_path,
        assets_dir,
    })
}

/// The repository's review profile: a present one validates and wins; an
/// absent one is built from the command's options, validated, written, and
/// re-read through the loader — what init writes must load exactly like an
/// operator-placed profile.
fn ensure_profile(options: &InitOptions, git_root: &Path) -> Result<(ReviewProfile, PathBuf)> {
    let profile_path = profile::profile_path(&options.agent_dir, git_root);
    let existing = profile::resolve_profile(&options.agent_dir, git_root)
        .map_err(|error| anyhow!("review profile: {error}"))?;
    if let Some(loaded) = existing {
        return Ok((loaded, profile_path));
    }
    let built = build_profile(options, git_root)?;
    built
        .validate(&profile_path)
        .map_err(|error| anyhow!("review profile: {error}"))?;
    let parent = profile_path.parent().ok_or_else(|| {
        anyhow!(
            "profile path {} has no parent directory",
            profile_path.display()
        )
    })?;
    std::fs::create_dir_all(parent).with_context(|| format!("creating {}", parent.display()))?;
    let body = serde_json::to_string_pretty(&built).context("serializing the review profile")?;
    std::fs::write(&profile_path, body)
        .with_context(|| format!("writing {}", profile_path.display()))?;
    // Re-read through the loader: what init wrote must load exactly like an
    // operator-placed profile.
    match profile::resolve_profile(&options.agent_dir, git_root)
        .map_err(|error| anyhow!("review profile: {error}"))?
    {
        Some(profile) => Ok((profile, profile_path)),
        None => bail!(
            "the profile written to {} does not resolve back",
            profile_path.display()
        ),
    }
}

/// Build a fresh profile from the command's options: the default wake name
/// and the canonical layers, each model defaulting to the main model.
fn build_profile(options: &InitOptions, git_root: &Path) -> Result<ReviewProfile> {
    let Some(main_model) = options.main_model.as_deref() else {
        bail!(
            "no review profile exists for this repository and no --main-model was given; \
             pass --main-model (or place a profile at {} first)",
            profile::profile_path(&options.agent_dir, git_root).display()
        );
    };
    let session_name = options.session_name.clone().unwrap_or_else(|| {
        let repository = git_root.file_name().map_or_else(
            || "repository".to_string(),
            |name| name.to_string_lossy().into_owned(),
        );
        format!("review-{repository}")
    });
    let mut layers: Vec<ReviewLayer> = DEFAULT_LAYERS
        .into_iter()
        .map(|name| ReviewLayer {
            name: name.to_string(),
            model: main_model.to_string(),
        })
        .collect();
    for (name, model) in &options.layers {
        match layers.iter_mut().find(|layer| &layer.name == name) {
            Some(layer) => layer.model.clone_from(model),
            None => layers.push(ReviewLayer {
                name: name.clone(),
                model: model.clone(),
            }),
        }
    }
    Ok(ReviewProfile {
        version: profile::PROFILE_VERSION,
        session_name,
        main_model: Some(main_model.to_string()),
        layers,
        attempt_timeout_seconds: options.attempt_timeout_seconds,
        max_attempts: options.max_attempts,
    })
}

/// Lay down the minimal `.big-brother` project-understanding assets
/// (ADR 0022): one inspectable overview recording the enrollment. The
/// model-driven bootstrap (narrative and structured code map) arrives with
/// the review reading tools; until then this overview is the whole asset.
/// Existing assets are never overwritten — later reviews own their update.
fn write_minimal_assets(
    git_root: &Path,
    branch: &str,
    cursor: &str,
    profile: &ReviewProfile,
    profile_path: &Path,
) -> Result<PathBuf> {
    let assets_dir = git_root.join(".big-brother");
    let overview = assets_dir.join("overview.md");
    if !overview.exists() {
        std::fs::create_dir_all(&assets_dir)
            .with_context(|| format!("creating {}", assets_dir.display()))?;
        let body = format!(
            "# Big Brother overview\n\
             \n\
             This working tree is enrolled for Big Brother review.\n\
             \n\
             - Tracked branch: `{branch}`\n\
             - Review baseline: `{cursor}` (reviews start from the next change)\n\
             - Conductor session: `{}` (woken by name per review range)\n\
             - Review profile: `{}` (operator side, outside this work tree)\n\
             \n\
             Query review progress with `big-brother status`.\n",
            profile.session_name,
            profile_path.display()
        );
        std::fs::write(&overview, body)
            .with_context(|| format!("writing {}", overview.display()))?;
    }
    Ok(assets_dir)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn options(git_root: &Path) -> InitOptions {
        InitOptions {
            socket_path: PathBuf::from("/nonexistent/daemon.sock"),
            agent_dir: git_root.parent().unwrap().join("agent"),
            repo: git_root.to_path_buf(),
            branch: None,
            session_name: None,
            main_model: Some("prime-inference/main".to_string()),
            layers: Vec::new(),
            attempt_timeout_seconds: None,
            max_attempts: None,
        }
    }

    fn watched_repo() -> (tempfile::TempDir, PathBuf) {
        let dir = tempfile::TempDir::new().unwrap();
        let git_root = dir.path().join("watched-repo");
        std::fs::create_dir_all(git_root.join(".git")).unwrap();
        (dir, git_root)
    }

    #[test]
    fn a_fresh_profile_uses_the_default_wake_name_and_canonical_layers() {
        let (_dir, git_root) = watched_repo();
        let options = options(&git_root);
        let profile = build_profile(&options, &git_root).unwrap();
        assert_eq!(profile.session_name, "review-watched-repo");
        assert_eq!(profile.main_model.as_deref(), Some("prime-inference/main"));
        assert_eq!(
            profile
                .layers
                .iter()
                .map(|layer| (layer.name.as_str(), layer.model.as_str()))
                .collect::<Vec<_>>(),
            [
                ("requirements", "prime-inference/main"),
                ("project-fit", "prime-inference/main"),
                ("implementation", "prime-inference/main"),
            ]
        );
        // The built profile validates and round-trips through its file.
        let path = profile::profile_path(&options.agent_dir, &git_root);
        profile.validate(&path).unwrap();
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(&path, serde_json::to_string(&profile).unwrap()).unwrap();
        let reloaded = profile::resolve_profile(&options.agent_dir, &git_root)
            .unwrap()
            .expect("loads back");
        assert_eq!(reloaded, profile);
    }

    #[test]
    fn explicit_layers_replace_defaults_or_append() {
        let (_dir, git_root) = watched_repo();
        let mut options = options(&git_root);
        options.layers = vec![
            (
                "requirements".to_string(),
                "provider/requirements".to_string(),
            ),
            ("security".to_string(), "provider/security".to_string()),
        ];
        let profile = build_profile(&options, &git_root).unwrap();
        assert_eq!(
            profile
                .layers
                .iter()
                .map(|layer| (layer.name.as_str(), layer.model.as_str()))
                .collect::<Vec<_>>(),
            [
                ("requirements", "provider/requirements"),
                ("project-fit", "prime-inference/main"),
                ("implementation", "prime-inference/main"),
                ("security", "provider/security"),
            ]
        );
    }

    #[test]
    fn a_fresh_profile_without_a_main_model_is_refused() {
        let (_dir, git_root) = watched_repo();
        let mut options = options(&git_root);
        options.main_model = None;
        let error = build_profile(&options, &git_root).unwrap_err();
        assert!(error.to_string().contains("--main-model"), "{error}");
    }

    #[test]
    fn ensure_profile_writes_then_validates_and_an_existing_profile_wins() {
        let (_dir, git_root) = watched_repo();
        let mut options = options(&git_root);
        options.session_name = Some("operator-name".to_string());
        let (written, path) = ensure_profile(&options, &git_root).unwrap();
        assert!(path.is_file());
        assert_eq!(written.session_name, "operator-name");
        // An operator-edited profile on a second run wins over the options.
        std::fs::write(
            &path,
            serde_json::json!({
                "version": 1, "sessionName": "hand-placed", "mainModel": "p/m",
                "layers": [{ "name": "solo", "model": "p/solo" }]
            })
            .to_string(),
        )
        .unwrap();
        let (reloaded, _) = ensure_profile(&options, &git_root).unwrap();
        assert_eq!(reloaded.session_name, "hand-placed");
        assert_eq!(reloaded.layers.len(), 1);
    }

    #[test]
    fn minimal_assets_are_written_once_and_never_overwritten() {
        let (_dir, git_root) = watched_repo();
        let init_options = options(&git_root);
        let profile = build_profile(&init_options, &git_root).unwrap();
        let path = profile::profile_path(&init_options.agent_dir, &git_root);
        let assets = write_minimal_assets(&git_root, "main", "abc", &profile, &path).unwrap();
        let overview = assets.join("overview.md");
        let first = std::fs::read_to_string(&overview).unwrap();
        assert!(first.contains("Tracked branch: `main`"));
        assert!(first.contains("`abc`"));
        // A second enrollment (different baseline) keeps the first overview.
        write_minimal_assets(&git_root, "main", "def", &profile, &path).unwrap();
        assert_eq!(std::fs::read_to_string(&overview).unwrap(), first);
    }
}
