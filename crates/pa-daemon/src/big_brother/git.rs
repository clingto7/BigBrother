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
}
