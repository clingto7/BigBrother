//! Immutable, agent-side evidence for one admitted review range.
//! Repository documents and OCR rules are data with provenance, never
//! instructions for the review runtime.

use std::path::Path;
use std::process::Command;

use anyhow::{Context as _, Result};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use super::git::git;
use super::state::{RepositoryStateStore, ReviewRange};

/// The versioned input shared by every reviewer and retry of a range.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReviewEvidence {
    pub version: u32,
    pub id: String,
    pub repository: String,
    pub branch: String,
    pub base: String,
    pub head: String,
    pub commits: Vec<CommitEvidence>,
    pub files: Vec<FileEvidence>,
    pub diff: String,
    pub project_material: Vec<SourceEvidence>,
    pub ocr: OcrEvidence,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CommitEvidence {
    pub sha: String,
    pub parents: Vec<String>,
    pub author_name: String,
    pub author_email: String,
    pub authored_at: String,
    pub committer_name: String,
    pub committed_at: String,
    pub message: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileEvidence {
    pub status: String,
    pub path: String,
    pub previous_path: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceEvidence {
    pub revision: String,
    pub path: String,
    pub content: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OcrEvidence {
    pub command: String,
    pub preview: Option<Value>,
    pub rules: Option<Value>,
    pub error: Option<String>,
}

/// Return the same evidence identity and asset across retries. An
/// interrupted write is replaced before the range is woken.
pub(crate) fn ensure_evidence(
    store: &RepositoryStateStore,
    branch: &str,
    range: &ReviewRange,
) -> Result<String> {
    let path = store.evidence_path(branch, &range.base, &range.head);
    let id = format!("{branch}:{}..{}", range.base, range.head);
    if path.exists() {
        let evidence: ReviewEvidence = serde_json::from_slice(&std::fs::read(&path)?)
            .with_context(|| format!("reading evidence {}", path.display()))?;
        anyhow::ensure!(
            evidence.id == id && evidence.version == 1,
            "evidence identity mismatch at {}",
            path.display()
        );
        return Ok(id);
    }
    let git_root = store.git_root();
    let revision_range = format!("{}..{}", range.base, range.head);
    let log = git(
        git_root,
        &[
            "log",
            "--reverse",
            "--format=%H%x00%P%x00%an%x00%ae%x00%aI%x00%cn%x00%cI%x00%B%x00",
            &revision_range,
        ],
    )?;
    let mut parts = log.split('\0');
    let mut commits = Vec::new();
    while let Some(sha) = parts.next() {
        if sha.trim().is_empty() {
            break;
        }
        let parents = parts
            .next()
            .context("git log omitted parents")?
            .split_whitespace()
            .map(str::to_string)
            .collect();
        let author_name = parts.next().context("git log omitted author")?.to_string();
        let author_email = parts
            .next()
            .context("git log omitted author email")?
            .to_string();
        let authored_at = parts
            .next()
            .context("git log omitted author time")?
            .to_string();
        let committer_name = parts
            .next()
            .context("git log omitted committer")?
            .to_string();
        let committed_at = parts
            .next()
            .context("git log omitted commit time")?
            .to_string();
        let message = parts
            .next()
            .context("git log omitted message")?
            .trim()
            .to_string();
        commits.push(CommitEvidence {
            sha: sha.trim().to_string(),
            parents,
            author_name,
            author_email,
            authored_at,
            committer_name,
            committed_at,
            message,
        });
    }
    let name_status = git(
        git_root,
        &["diff", "--name-status", "-z", &range.base, &range.head],
    )?;
    let mut fields = name_status.split('\0').filter(|field| !field.is_empty());
    let mut files = Vec::new();
    while let Some(status) = fields.next() {
        let first = fields.next().context("git diff omitted a changed path")?;
        let (path, previous_path) = if status.starts_with('R') || status.starts_with('C') {
            (
                fields
                    .next()
                    .context("git diff omitted a rename destination")?
                    .to_string(),
                Some(first.to_string()),
            )
        } else {
            (first.to_string(), None)
        };
        files.push(FileEvidence {
            status: status.to_string(),
            path,
            previous_path,
        });
    }
    let diff = git(git_root, &["diff", "--binary", &range.base, &range.head])?;
    let tree = git(git_root, &["ls-tree", "-r", "--name-only", &range.head])?;
    let mut project_material = Vec::new();
    for path in tree.lines().filter(|path| {
        *path == "AGENTS.md"
            || *path == "CONTEXT.md"
            || *path == "GLOSSARY.md"
            || *path == ".cursor/BUGBOT.md"
            || path.starts_with("docs/adr/")
            || path.ends_with("/AGENTS.md")
    }) {
        let spec = format!("{}:{path}", range.head);
        if let Ok(content) = git(git_root, &["show", &spec]) {
            project_material.push(SourceEvidence {
                revision: range.head.clone(),
                path: path.to_string(),
                content,
            });
        }
    }
    let ocr = ocr_evidence(git_root, &range.base, &range.head);
    let evidence = ReviewEvidence {
        version: 1,
        id: id.clone(),
        repository: git_root.display().to_string(),
        branch: branch.to_string(),
        base: range.base.clone(),
        head: range.head.clone(),
        commits,
        files,
        diff,
        project_material,
        ocr,
    };
    std::fs::create_dir_all(path.parent().context("evidence parent")?)?;
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, serde_json::to_vec_pretty(&evidence)?)?;
    std::fs::rename(&tmp, &path)?;
    Ok(id)
}

fn ocr_evidence(repo: &Path, base: &str, head: &str) -> OcrEvidence {
    let command = format!("ocr delegate preview --format json --from {base} --to {head}");
    let preview = Command::new("ocr")
        .current_dir(repo)
        .args([
            "delegate", "preview", "--format", "json", "--from", base, "--to", head,
        ])
        .output();
    let Ok(preview) = preview else {
        return OcrEvidence {
            command,
            preview: None,
            rules: None,
            error: Some("OCR executable unavailable".to_string()),
        };
    };
    if !preview.status.success() {
        return OcrEvidence {
            command,
            preview: None,
            rules: None,
            error: Some(String::from_utf8_lossy(&preview.stderr).trim().to_string()),
        };
    }
    let Ok(preview): Result<Value, _> = serde_json::from_slice(&preview.stdout) else {
        return OcrEvidence {
            command,
            preview: None,
            rules: None,
            error: Some("OCR preview returned invalid JSON".to_string()),
        };
    };
    let paths: Vec<&str> = preview["reviewable_files"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|file| file["path"].as_str())
        .collect();
    if paths.is_empty() {
        return OcrEvidence {
            command,
            preview: Some(preview),
            rules: None,
            error: None,
        };
    }
    let rules = Command::new("ocr")
        .current_dir(repo)
        .args([
            "delegate", "rule", "--format", "json", "--from", base, "--to", head,
        ])
        .args(&paths)
        .output();
    match rules {
        Ok(output) if output.status.success() => match serde_json::from_slice(&output.stdout) {
            Ok(rules) => OcrEvidence {
                command,
                preview: Some(preview),
                rules: Some(rules),
                error: None,
            },
            Err(error) => OcrEvidence {
                command,
                preview: Some(preview),
                rules: None,
                error: Some(format!("OCR rules returned invalid JSON: {error}")),
            },
        },
        Ok(output) => OcrEvidence {
            command,
            preview: Some(preview),
            rules: None,
            error: Some(String::from_utf8_lossy(&output.stderr).trim().to_string()),
        },
        Err(error) => OcrEvidence {
            command,
            preview: Some(preview),
            rules: None,
            error: Some(error.to_string()),
        },
    }
}
