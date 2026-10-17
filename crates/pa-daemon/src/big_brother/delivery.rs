//! Delivery channels (ADR 0021/0029): the completed record is the
//! common source; every enabled channel carries it out with independent
//! durable state, and the observer's scan retries pending channels.
//! Channel sends are at-least-once — a crash between a send and its
//! record update replays the send (idempotent for Commit Status under
//! the stable context, bounded for Bark by the record set).

use std::path::Path;
use std::time::Duration;

use anyhow::{anyhow, bail, Context as _, Result};
use serde_json::{json, Value};

use crate::big_brother::git::origin_github_slug;
use crate::big_brother::state::{DeliveryState, RepositoryStateStore, ReviewRecord};

/// The stable Commit Status context (ADR 0012).
const STATUS_CONTEXT: &str = "big-brother/review";
/// GitHub caps a status description at 140 characters.
const STATUS_DESCRIPTION_CAP: usize = 140;
/// A pending channel retries no more often than this (ADR 0029): the
/// scan stays fast while a hard-down endpoint is probed at the minute.
const RETRY_AFTER: Duration = Duration::from_secs(60);
/// One delivery send's total budget.
const SEND_TIMEOUT: Duration = Duration::from_secs(10);
/// The channel names inside `record.delivery`.
const COMMIT_STATUS_CHANNEL: &str = "commit-status";
const BARK_CHANNEL: &str = "bark";

/// The delivery channels resolved from the observer's environment
/// (ADR 0029). An absent key silently disables its channel; a key
/// enabled later retro-delivers past records on the next scan.
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct DeliveryChannels {
    bark: Option<BarkConfig>,
    github: Option<GitHubConfig>,
}

/// One Bark push target: the short push key (never the APNs device
/// token) and the server it belongs to.
#[derive(Debug, Clone, PartialEq)]
struct BarkConfig {
    key: String,
    server: String,
}

/// One GitHub Commit Status target: the status-write token and the API
/// base (the deployment's proxy seam).
#[derive(Debug, Clone, PartialEq)]
struct GitHubConfig {
    token: String,
    api_url: String,
}

impl DeliveryChannels {
    /// Resolve from the observer process's environment.
    pub(crate) fn from_env() -> Self {
        Self::resolve(|name| {
            std::env::var(name)
                .ok()
                .filter(|value| !value.trim().is_empty())
        })
    }

    /// Resolve through one lookup (the seam the unit tests drive). A
    /// blank value counts as absent.
    pub(crate) fn resolve(lookup: impl Fn(&str) -> Option<String>) -> Self {
        let lookup = |name: &str| lookup(name).filter(|value| !value.trim().is_empty());
        let bark = lookup("BARK_KEY").map(|key| BarkConfig {
            key,
            server: lookup("BARK_SERVER").unwrap_or_else(|| "https://api.day.app".to_string()),
        });
        let github = lookup("BIG_BROTHER_GITHUB_TOKEN").map(|token| GitHubConfig {
            token,
            api_url: lookup("BIG_BROTHER_GITHUB_API_URL")
                .unwrap_or_else(|| "https://api.github.com".to_string()),
        });
        DeliveryChannels { bark, github }
    }

    /// Whether no channel is configured and scans can skip delivery.
    pub(crate) fn is_empty(&self) -> bool {
        self.bark.is_none() && self.github.is_none()
    }
}

/// The advisory Commit Status body (ADR 0012/0029): `success` under the
/// stable context; the description is the synthesis's first line.
fn status_payload(record: &ReviewRecord) -> Value {
    json!({
        "state": "success",
        "context": STATUS_CONTEXT,
        "description": capped(conclusion_line(record), STATUS_DESCRIPTION_CAP),
    })
}

/// The Bark push body: the group's notifications, one synthesis line.
fn bark_payload(repo_name: &str, record: &ReviewRecord) -> Value {
    json!({
        "title": format!("big-brother {repo_name}"),
        "body": format!(
            "reviewed {}..{}: {}",
            short_revision(&record.base),
            short_revision(&record.head),
            conclusion_line(record)
        ),
        "group": "big-brother",
    })
}

/// Deliver every enabled channel's pending state for one repository's
/// records (ADR 0029). Channel send failures are recorded per channel
/// and retried later — never propagated; only infrastructure failures
/// (git, the store, the HTTP client) fail the pass.
pub(crate) async fn deliver_pending(
    store: &RepositoryStateStore,
    channels: &DeliveryChannels,
    git_root: &Path,
) -> Result<()> {
    if channels.is_empty() {
        return Ok(());
    }
    let repo_name = git_root.file_name().map_or_else(
        || "repository".to_string(),
        |name| name.to_string_lossy().into_owned(),
    );
    // The slug resolves once per repository: a non-GitHub origin leaves
    // the Commit Status channel off (ADR 0029).
    let slug = channels
        .github
        .is_some()
        .then(|| origin_github_slug(git_root))
        .transpose()?
        .flatten();
    let http = reqwest::Client::builder()
        .timeout(SEND_TIMEOUT)
        .build()
        .context("building the delivery HTTP client")?;
    let state = store.load()?;
    for branch in state.branches.keys() {
        let records = store.records(branch)?;
        for record in records {
            deliver_record(
                store,
                channels,
                &http,
                branch,
                &record,
                slug.as_deref(),
                &repo_name,
            )
            .await?;
        }
    }
    Ok(())
}

/// One record's channels: each pending-and-due channel gets one send,
/// and its outcome lands in the record whatever it was.
async fn deliver_record(
    store: &RepositoryStateStore,
    channels: &DeliveryChannels,
    http: &reqwest::Client,
    branch: &str,
    record: &ReviewRecord,
    slug: Option<&str>,
    repo_name: &str,
) -> Result<()> {
    let now_ms = crate::util::now_ms();
    if let (Some(config), Some(slug)) = (&channels.github, slug) {
        if retry_due(record.delivery.get(COMMIT_STATUS_CHANNEL), now_ms) {
            let outcome = send_commit_status(http, config, slug, record).await;
            record_outcome(store, branch, record, COMMIT_STATUS_CHANNEL, outcome)?;
        }
    }
    if let Some(config) = &channels.bark {
        if retry_due(record.delivery.get(BARK_CHANNEL), now_ms) {
            let outcome = send_bark(http, config, repo_name, record).await;
            record_outcome(store, branch, record, BARK_CHANNEL, outcome)?;
        }
    }
    Ok(())
}

/// Persist one channel's attempt outcome and log it (ADR 0029: the
/// state advances on success AND failure — a pending channel with its
/// error and attempt count is what the next scan retries from).
fn record_outcome(
    store: &RepositoryStateStore,
    branch: &str,
    record: &ReviewRecord,
    channel: &str,
    outcome: Result<()>,
) -> Result<()> {
    let now = crate::util::now_iso();
    let error = outcome.as_ref().err().map(std::string::ToString::to_string);
    let state = DeliveryState::advance(record.delivery.get(channel), now, error);
    match outcome {
        Ok(()) => eprintln!(
            "big-brother observer: {channel} delivered for {} on {branch}",
            short_revision(&record.head)
        ),
        Err(error) => eprintln!(
            "big-brother observer: {channel} attempt {} for {} on {branch} failed: {error:#}",
            state.attempts,
            short_revision(&record.head)
        ),
    }
    store
        .update_delivery(branch, &record.head, channel, state)
        .map_err(|error| anyhow!("recording {channel} delivery on {}: {error}", record.head))
}

/// Whether a channel's entry is due for its next send: never once
/// delivered, immediately when never attempted, and no more often than
/// [`RETRY_AFTER`] after the last attempt.
fn retry_due(entry: Option<&DeliveryState>, now_ms: u64) -> bool {
    match entry {
        None => true,
        Some(state) if state.delivered() => false,
        Some(state) => {
            let last_ms = crate::util::iso_to_unix_ms(&state.last_attempt_at).unwrap_or(0);
            now_ms.saturating_sub(last_ms) >= RETRY_AFTER.as_millis() as u64
        }
    }
}

/// Post the record's Commit Status (ADR 0012): one advisory `success`
/// under the stable context for the range's head commit.
async fn send_commit_status(
    http: &reqwest::Client,
    config: &GitHubConfig,
    slug: &str,
    record: &ReviewRecord,
) -> Result<()> {
    let url = format!(
        "{}/repos/{slug}/statuses/{}",
        config.api_url.trim_end_matches('/'),
        record.head
    );
    let response = http
        .post(&url)
        .bearer_auth(&config.token)
        .header("Accept", "application/vnd.github+json")
        .json(&status_payload(record))
        .send()
        .await
        .with_context(|| format!("POST {url}"))?;
    let status = response.status();
    if !status.is_success() {
        let body = response.text().await.unwrap_or_default();
        bail!(
            "commit status POST returned {status}: {}",
            capped(&body, 300)
        );
    }
    Ok(())
}

/// Push the record's Bark notification: HTTP 200 with `code` 200 is
/// the only success shape.
async fn send_bark(
    http: &reqwest::Client,
    config: &BarkConfig,
    repo_name: &str,
    record: &ReviewRecord,
) -> Result<()> {
    let url = format!("{}/{}", config.server.trim_end_matches('/'), config.key);
    let response = http
        .post(&url)
        .json(&bark_payload(repo_name, record))
        .send()
        .await
        .context("POST the bark server")?;
    let status = response.status();
    let body = response.text().await.unwrap_or_default();
    if !status.is_success() {
        bail!("bark POST returned {status}: {}", capped(&body, 300));
    }
    let parsed: Value = serde_json::from_str(body.trim())
        .with_context(|| format!("bark answered non-JSON: {}", capped(&body, 300)))?;
    if parsed.get("code").and_then(Value::as_i64) != Some(200) {
        bail!(
            "bark rejected the push: {}",
            capped(&parsed.to_string(), 300)
        );
    }
    Ok(())
}

/// The synthesis's first non-empty line, or the neutral fallback when
/// no synthesis was captured — one line is all a status or push
/// carries.
fn conclusion_line(record: &ReviewRecord) -> &str {
    record
        .conclusion
        .as_deref()
        .and_then(|text| text.lines().find(|line| !line.trim().is_empty()))
        .unwrap_or("review completed")
}

/// A string capped to `cap` characters, ellipsized when it was longer.
fn capped(text: &str, cap: usize) -> String {
    if text.chars().count() > cap {
        let prefix: String = text.chars().take(cap - 1).collect();
        format!("{prefix}…")
    } else {
        text.to_string()
    }
}

/// A readable revision prefix for one-line surfaces.
fn short_revision(revision: &str) -> String {
    revision.chars().take(8).collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::BTreeMap;

    const BASE: &str = "0123456789abcdef0123456789abcdef01234567";
    const HEAD: &str = "89abcdef0123456789abcdef0123456789abcdef";

    fn record() -> ReviewRecord {
        ReviewRecord {
            version: 1,
            branch: "main".to_string(),
            base: BASE.to_string(),
            head: HEAD.to_string(),
            attempts: 1,
            completed_at: "2026-10-17T00:00:00.000Z".to_string(),
            layers: Vec::new(),
            conclusion: Some("clean range\nsecond line".to_string()),
            delivery: BTreeMap::new(),
        }
    }

    fn lookup<'a>(pairs: &'a [(&'a str, &'a str)]) -> impl Fn(&str) -> Option<String> + 'a {
        move |name| {
            pairs
                .iter()
                .find(|(key, _)| *key == name)
                .map(|(_, value)| (*value).to_string())
        }
    }

    #[test]
    fn channels_resolve_from_env_names_with_defaults() {
        let both = DeliveryChannels::resolve(lookup(&[
            ("BARK_KEY", "shortkey"),
            ("BIG_BROTHER_GITHUB_TOKEN", "ghp-token"),
        ]));
        assert!(!both.is_empty());
        // Defaults: the public Bark server and the GitHub API.
        assert_eq!(
            both.bark.as_ref().expect("bark").server,
            "https://api.day.app"
        );
        assert_eq!(
            both.github.as_ref().expect("github").api_url,
            "https://api.github.com"
        );
        // Overrides reach through.
        let overridden = DeliveryChannels::resolve(lookup(&[
            ("BARK_KEY", "shortkey"),
            ("BARK_SERVER", "https://bark.example.invalid"),
            ("BIG_BROTHER_GITHUB_TOKEN", "ghp-token"),
            (
                "BIG_BROTHER_GITHUB_API_URL",
                "https://gh.example.invalid/api/v3",
            ),
        ]));
        assert_eq!(
            overridden.bark.as_ref().expect("bark").server,
            "https://bark.example.invalid"
        );
        assert_eq!(
            overridden.github.as_ref().expect("github").api_url,
            "https://gh.example.invalid/api/v3"
        );
        // Absent keys disable their channel silently (ADR 0029).
        let bare = DeliveryChannels::resolve(lookup(&[("BARK_KEY", "shortkey")]));
        assert!(bare.github.is_none() && !bare.is_empty());
        assert!(DeliveryChannels::resolve(|_| None).is_empty());
        // Blank values count as absent.
        let blank = DeliveryChannels::resolve(lookup(&[("BARK_KEY", "  ")]));
        assert!(blank.bark.is_none());
    }

    #[test]
    fn the_status_body_is_advisory_success_under_the_stable_context() {
        let body = status_payload(&record());
        assert_eq!(body["state"], json!("success"));
        assert_eq!(body["context"], json!(STATUS_CONTEXT));
        assert_eq!(body["description"], json!("clean range"));
        // No synthesis captured: the neutral fallback, never an empty
        // description.
        let mut bare = record();
        bare.conclusion = None;
        assert_eq!(
            status_payload(&bare)["description"],
            json!("review completed")
        );
        // GitHub's 140-character cap, ellipsized.
        let mut long = record();
        long.conclusion = Some("x".repeat(200));
        let description = status_payload(&long)["description"]
            .as_str()
            .expect("description")
            .to_string();
        assert_eq!(description.chars().count(), STATUS_DESCRIPTION_CAP);
        assert!(description.ends_with('…'));
    }

    #[test]
    fn the_bark_body_carries_one_synthesis_line() {
        let body = bark_payload("yadig", &record());
        assert_eq!(body["title"], json!("big-brother yadig"));
        assert_eq!(body["group"], json!("big-brother"));
        assert_eq!(
            body["body"],
            json!("reviewed 01234567..89abcdef: clean range")
        );
    }

    #[test]
    fn pending_channels_retry_at_the_minute_not_the_scan() {
        let iso = |text: &str| crate::util::iso_to_unix_ms(text).expect("iso");
        let stamp = "2026-10-17T00:00:00.000Z";
        // Never attempted: due now.
        assert!(retry_due(None, 0));
        // A failed attempt stays pending within the window…
        let pending = DeliveryState::advance(None, stamp.to_string(), Some("HTTP 500".to_string()));
        assert!(!retry_due(Some(&pending), iso(stamp) + 30_000));
        // …and is due at and after it.
        assert!(retry_due(Some(&pending), iso(stamp) + 60_000));
        // Delivered: never again.
        let done = DeliveryState::advance(Some(&pending), stamp.to_string(), None);
        assert!(!retry_due(Some(&done), iso(stamp) + 3_600_000));
        // An unparseable stamp on a pending entry is due immediately
        // (corrupt state should surface, not stall delivery).
        let corrupt = DeliveryState::advance(
            None,
            "not-a-stamp".to_string(),
            Some("HTTP 500".to_string()),
        );
        assert!(retry_due(Some(&corrupt), iso(stamp)));
    }
}
