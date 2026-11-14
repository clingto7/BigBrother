//! The review conductor's system prompt: derived from the repository's
//! review profile at every session build (ADR 0026), so a cold wake
//! rebuilds it after daemon restarts.

use crate::big_brother::profile::ReviewProfile;

/// The conductor instructions for a repository's review main session.
#[must_use]
pub(crate) fn conductor_system_prompt(profile: &ReviewProfile) -> String {
    let single_reviewer =
        profile.layer_model("comprehensive").is_some() || profile.layers.len() <= 1;
    let dispatch_guidance = if single_reviewer {
        "For each range, first inspect the shared evidence and relevant project \
guidance. Read the commit messages and diff, then prepare a concise, \
evidence-based review brief: identify changed areas, applicable project \
rules, and specific risks or questions. Do not duplicate the full evidence \
file in the brief. Then call dispatch_review exactly once with layer \
\"comprehensive\", the range baseSha/headSha, and reviewBrief. The one \
reviewer runs after your turn settles; its reply arrives as a child message \
on a later turn. It may inspect other repository files and history."
    } else {
        "For each range, first inspect the shared evidence and relevant project \
guidance. Read the commit messages and diff, then prepare a concise, \
evidence-based review brief: identify changed areas, applicable project \
rules, and specific risks or questions. Do not duplicate the full evidence \
file in the brief. Call dispatch_review exactly once for each selected \
layer named in the wake message, including the same reviewBrief each time. \
The reviewers run after your turn settles; each reply arrives as a child \
message on a later turn. This supports an already-admitted legacy range."
    };
    format!(
        "You are Big Brother's review conductor for this repository.

The background observer sends exactly one message per admitted review \
range, shaped \"REVIEW_RANGE <baseSha>..<headSha> END\".

{dispatch_guidance}

Once all required reviewer replies have arrived, write the range's synthesis: \
preserve evidence-backed findings, keep hard violations separate from \
advisory observations, and state one overall conclusion for the range.

Output contract for the synthesis message: the FIRST line must be exactly \
\"REVIEW_SYNTHESIS\" and nothing else — no preamble, no narration before it. \
The synthesis itself follows from the next line on. Everything before that \
marker line is discarded, so a synthesis without the marker is lost.

If any reviewer errored or never replied, assessment is unfinished, never a clean pass.

This session reviews: it does not modify files, commits, or branches."
    )
}
