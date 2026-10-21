//! Reading and advancing the watched work tree's git facts.

use std::path::Path;

use anyhow::{Context as _, Result};

/// Why a review worktree could not be advanced to its remote branch.
#[derive(Debug, thiserror::Error)]
pub(crate) enum WorktreeSyncError {
    /// The configured branch is not the worktree's checked-out branch.
    #[error("review worktree is on {actual}, expected branch {expected}")]
    WrongBranch { actual: String, expected: String },
    /// The worktree contains changes that the observer must not overwrite.
    #[error("review worktree has uncommitted or untracked changes")]
    Dirty,
    /// Fetch could not update the remote-tracking ref.
    #[error("fetch failed: {0}")]
    Fetch(String),
    /// The local branch cannot be fast-forwarded to the fetched ref.
    #[error("fast-forward failed: {0}")]
    NonFastForward(String),
}

impl WorktreeSyncError {
    /// Stable state-field value for operators and future query surfaces.
    pub(crate) fn kind(&self) -> &'static str {
        match self {
            Self::WrongBranch { .. } => "wrong_branch",
            Self::Dirty => "dirty_worktree",
            Self::Fetch(_) => "fetch_failed",
            Self::NonFastForward(_) => "non_fast_forward",
        }
    }
}

/// Run one git command in the work tree and return its trimmed stdout.
fn git(git_root: &Path, args: &[&str]) -> Result<String> {
    let output = std::process::Command::new("git")
        .arg("-C")
        .arg(git_root)
        .args(args)
        // Observation must not contend with a user's commit for the index
        // lock; status can refresh the index unless optional locks are off.
        .env("GIT_OPTIONAL_LOCKS", "0")
        .output()
        .with_context(|| format!("running git {} in {}", args.join(" "), git_root.display()))?;
    if !output.status.success() {
        anyhow::bail!(
            "git {} in {}: {}",
            args.join(" "),
            git_root.display(),
            String::from_utf8_lossy(&output.stderr).trim()
        );
    }
    Ok(String::from_utf8(output.stdout)?.trim().to_string())
}

/// The tracked branch's head in the persistent work tree.
pub(crate) fn branch_head(git_root: &Path, branch: &str) -> Result<String> {
    git(git_root, &["rev-parse", branch])
}

/// Resolve the branch to use when enrollment did not name one. The remote's
/// symbolic default wins, followed by the conventional local branches.
pub(crate) fn default_branch(git_root: &Path) -> Result<Option<String>> {
    let remote_default = git(
        git_root,
        &[
            "symbolic-ref",
            "--quiet",
            "--short",
            "refs/remotes/origin/HEAD",
        ],
    )
    .ok()
    .and_then(|value| value.strip_prefix("origin/").map(str::to_owned));
    let candidates = remote_default
        .into_iter()
        .chain(["main".to_owned(), "master".to_owned()]);
    for branch in candidates {
        if git(
            git_root,
            &[
                "show-ref",
                "--verify",
                "--quiet",
                &format!("refs/heads/{branch}"),
            ],
        )
        .is_ok()
        {
            return Ok(Some(branch));
        }
    }
    Ok(None)
}

/// Fetch the tracked remote branch and fast-forward the dedicated review
/// worktree to it. The worktree must be clean and currently checked out on
/// `branch`; neither condition is silently repaired.
pub(crate) fn fetch_and_fast_forward(
    git_root: &Path,
    branch: &str,
) -> std::result::Result<(), WorktreeSyncError> {
    let current =
        current_branch(git_root).map_err(|error| WorktreeSyncError::Fetch(error.to_string()))?;
    if current.as_deref() != Some(branch) {
        return Err(WorktreeSyncError::WrongBranch {
            actual: current.unwrap_or_else(|| "detached HEAD".to_owned()),
            expected: branch.to_owned(),
        });
    }
    let status = git(
        git_root,
        &["status", "--porcelain", "--untracked-files=all"],
    )
    .map_err(|error| WorktreeSyncError::Fetch(error.to_string()))?;
    let has_user_changes = status.lines().any(|line| {
        let path = line.get(3..).unwrap_or(line).trim();
        path != ".big-brother" && !path.starts_with(".big-brother/")
    });
    if has_user_changes {
        return Err(WorktreeSyncError::Dirty);
    }
    // Local-only repositories remain supported for development and existing
    // enrollments. With no origin there is nothing safe to fetch, so the
    // observer keeps watching the checked-out local branch.
    let remotes =
        git(git_root, &["remote"]).map_err(|error| WorktreeSyncError::Fetch(error.to_string()))?;
    if !remotes.lines().any(|remote| remote.trim() == "origin") {
        return Ok(());
    }
    // An enrolled local-only branch may have an `origin` used only for
    // publication (for example a Commit Status target) without a fetch
    // upstream. Do not turn that legacy setup into an unsolicited network
    // request; a prepared review clone has an explicit origin upstream.
    if git(
        git_root,
        &["config", "--get", &format!("branch.{branch}.remote")],
    )
    .is_err()
    {
        return Ok(());
    }
    git(git_root, &["fetch", "origin", branch])
        .map_err(|error| WorktreeSyncError::Fetch(error.to_string()))?;
    git(
        git_root,
        &[
            "merge",
            "--ff-only",
            &format!("refs/remotes/origin/{branch}"),
        ],
    )
    .map_err(|error| WorktreeSyncError::NonFastForward(error.to_string()))?;
    Ok(())
}

/// The work tree's current branch; `None` when HEAD is detached.
pub(crate) fn current_branch(git_root: &Path) -> Result<Option<String>> {
    let branch = git(git_root, &["rev-parse", "--abbrev-ref", "HEAD"])?;
    Ok((branch != "HEAD").then_some(branch))
}

/// The work tree's `origin` remote as a GitHub `owner/repo` slug (ADR
/// 0029's Commit Status target). `Ok(None)` when there is no origin or
/// it lives on another host — the channel stays off for that repository.
pub(crate) fn origin_github_slug(git_root: &Path) -> Result<Option<String>> {
    let remotes = git(git_root, &["remote"])?;
    if !remotes.lines().any(|name| name.trim() == "origin") {
        return Ok(None);
    }
    let url = git(git_root, &["remote", "get-url", "origin"])?;
    Ok(parse_github_slug(&url))
}

/// The `owner/repo` of a GitHub remote URL: scp-style SSH, `ssh://`, or
/// HTTPS (with or without embedded credentials); `None` for any other
/// host or shape.
fn parse_github_slug(url: &str) -> Option<String> {
    let path = url
        .strip_prefix("git@github.com:")
        .or_else(|| url.strip_prefix("ssh://git@github.com/"))
        .map_or_else(
            || {
                let (_, rest) = url.split_once("://")?;
                let (_, host_path) = rest.split_once('@').unwrap_or(("", rest));
                let (host, path) = host_path.split_once('/')?;
                host.eq_ignore_ascii_case("github.com")
                    .then_some(path.to_string())
            },
            |path| Some(path.to_string()),
        )?;
    let path = path.trim_end_matches(".git");
    let (owner, repo) = path.split_once('/')?;
    let part = |value: &str| !value.is_empty() && !value.contains('/');
    (part(owner) && part(repo)).then(|| format!("{owner}/{repo}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A throwaway test repository may set its own commit identity
    /// (AGENTS.md); the machine's repos must not.
    fn commit(repo: &Path, message: &str) {
        let mut args: Vec<&str> = vec![
            "-c",
            "user.name=Test",
            "-c",
            "user.email=test@example.invalid",
        ];
        args.extend(["commit", "-qm", message]);
        git(repo, &args).unwrap();
    }

    #[test]
    fn current_branch_resolves_and_detached_head_is_none() {
        let dir = tempfile::TempDir::new().unwrap();
        let repo = dir.path().join("repo");
        std::fs::create_dir_all(&repo).unwrap();
        git(&repo, &["init", "-q"]).unwrap();
        std::fs::write(repo.join("file.txt"), "x").unwrap();
        git(&repo, &["add", "file.txt"]).unwrap();
        commit(&repo, "baseline");
        let branch = current_branch(&repo)
            .unwrap()
            .expect("a named branch while HEAD is attached");
        assert_eq!(branch_head(&repo, &branch).unwrap().len(), 40);
        git(&repo, &["checkout", "-q", "--detach"]).unwrap();
        assert_eq!(current_branch(&repo).unwrap(), None);
        // A missing work tree is a loud error, not a branch.
        assert!(current_branch(&dir.path().join("missing")).is_err());
    }

    #[test]
    fn github_slugs_parse_from_every_remote_form() {
        let slug = |url| parse_github_slug(url).unwrap();
        assert_eq!(slug("git@github.com:clingto7/yadig.git"), "clingto7/yadig");
        assert_eq!(slug("git@github.com:clingto7/yadig"), "clingto7/yadig");
        assert_eq!(
            slug("ssh://git@github.com/clingto7/yadig.git"),
            "clingto7/yadig"
        );
        assert_eq!(
            slug("https://github.com/clingto7/yadig.git"),
            "clingto7/yadig"
        );
        assert_eq!(
            slug("https://token@github.com/clingto7/yadig"),
            "clingto7/yadig"
        );
        assert_eq!(parse_github_slug("https://gitlab.com/a/b"), None);
        assert_eq!(parse_github_slug("git@gitlab.com:a/b.git"), None);
        assert_eq!(parse_github_slug("https://github.com/only-owner"), None);
        assert_eq!(parse_github_slug("https://github.com/a/b/c"), None);
    }

    #[test]
    fn origin_slug_follows_the_origin_remote() {
        let dir = tempfile::TempDir::new().unwrap();
        let repo = dir.path().join("repo");
        std::fs::create_dir_all(&repo).unwrap();
        git(&repo, &["init", "-q"]).unwrap();
        // No remote at all: no slug, not an error.
        assert_eq!(origin_github_slug(&repo).unwrap(), None);
        git(
            &repo,
            &[
                "remote",
                "add",
                "origin",
                "git@github.com:clingto7/yadig.git",
            ],
        )
        .unwrap();
        assert_eq!(
            origin_github_slug(&repo).unwrap().as_deref(),
            Some("clingto7/yadig")
        );
        // A non-GitHub origin leaves the channel off.
        git(
            &repo,
            &[
                "remote",
                "set-url",
                "origin",
                "https://example.invalid/a/b.git",
            ],
        )
        .unwrap();
        assert_eq!(origin_github_slug(&repo).unwrap(), None);
    }

    #[test]
    fn fetch_fast_forwards_a_clean_review_worktree() {
        let dir = tempfile::TempDir::new().unwrap();
        let remote = dir.path().join("remote.git");
        let source = dir.path().join("source");
        let work = dir.path().join("work");
        std::fs::create_dir_all(&remote).unwrap();
        std::fs::create_dir_all(&source).unwrap();
        std::fs::create_dir_all(&work).unwrap();
        git(&remote, &["init", "--bare", "-q"]).unwrap();
        git(&source, &["init", "-q"]).unwrap();
        git(&source, &["checkout", "-q", "-b", "main"]).unwrap();
        std::fs::write(source.join("file.txt"), "one\n").unwrap();
        git(&source, &["add", "file.txt"]).unwrap();
        commit(&source, "one");
        git(
            &source,
            &["remote", "add", "origin", remote.to_str().unwrap()],
        )
        .unwrap();
        git(&source, &["push", "-q", "-u", "origin", "main"]).unwrap();
        git(&remote, &["symbolic-ref", "HEAD", "refs/heads/main"]).unwrap();

        git(&work, &["init", "-q"]).unwrap();
        git(
            &work,
            &["remote", "add", "origin", remote.to_str().unwrap()],
        )
        .unwrap();
        git(&work, &["fetch", "-q", "origin", "main"]).unwrap();
        git(&work, &["checkout", "-q", "-b", "main", "origin/main"]).unwrap();
        let first = branch_head(&work, "main").unwrap();

        std::fs::write(source.join("file.txt"), "one\ntwo\n").unwrap();
        git(&source, &["add", "file.txt"]).unwrap();
        commit(&source, "two");
        git(&source, &["push", "-q", "origin", "main"]).unwrap();

        fetch_and_fast_forward(&work, "main").unwrap();
        assert_ne!(branch_head(&work, "main").unwrap(), first);
        assert_eq!(
            std::fs::read_to_string(work.join("file.txt")).unwrap(),
            "one\ntwo\n"
        );
    }

    #[test]
    fn fetch_refuses_a_dirty_review_worktree() {
        let dir = tempfile::TempDir::new().unwrap();
        let repo = dir.path().join("repo");
        std::fs::create_dir_all(&repo).unwrap();
        git(&repo, &["init", "-q"]).unwrap();
        git(&repo, &["checkout", "-q", "-b", "main"]).unwrap();
        std::fs::write(repo.join("file.txt"), "one\n").unwrap();
        git(&repo, &["add", "file.txt"]).unwrap();
        commit(&repo, "one");
        std::fs::write(repo.join("file.txt"), "changed\n").unwrap();

        let error = fetch_and_fast_forward(&repo, "main").unwrap_err();
        assert!(matches!(error, WorktreeSyncError::Dirty));
    }
}
