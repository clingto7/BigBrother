//! Reading the watched work tree's git facts: the tracked branch's head
//! (observation, ADR 0027) and the current branch (enrollment, ADR 0022).

use std::path::Path;

use anyhow::{Context as _, Result};

/// Run one git command in the work tree and return its trimmed stdout.
fn git(git_root: &Path, args: &[&str]) -> Result<String> {
    let output = std::process::Command::new("git")
        .arg("-C")
        .arg(git_root)
        .args(args)
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
}
