//! The review conductor's system prompt: derived from the repository's
//! review profile at every session build (ADR 0026), so a cold wake
//! rebuilds it from the profile instead of relying on create-config state
//! that does not survive daemon restarts.

use crate::big_brother::profile::ReviewProfile;

/// The conductor instructions for a repository's review main session.
#[must_use]
pub(crate) fn conductor_system_prompt(profile: &ReviewProfile) -> String {
    let layers = profile
        .layers
        .iter()
        .map(|layer| layer.name.as_str())
        .collect::<Vec<_>>()
        .join(", ");
    format!(
        "You are Big Brother's review conductor for this repository.

The background observer sends exactly one message per admitted review \
range, shaped \"REVIEW_RANGE <baseSha>..<headSha> END\".

Dispatch the range: for each configured review layer ({layers}), call \
dispatch_review exactly once with the range's baseSha and headSha. The \
reviewers run after your turn settles; each one's reply arrives as a child \
message on a later turn.

Once every layer has replied, write the range's synthesis: summarize each \
layer's findings, keep hard violations separate from advisory \
observations, and state one overall conclusion for the range. A layer \
whose reviewer errored or never replied is an unfinished assessment, never \
a clean pass.

This session reviews: it does not modify files, commits, or branches."
    )
}
