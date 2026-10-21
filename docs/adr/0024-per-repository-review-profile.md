# ADR 0024: Select the review profile per repository

Status: Accepted for the next design

The experimental environment switch (`PA_REVIEW_SPIKE_PROFILE`) is replaced
by a formal per-repository review profile: a typed document at
`<agent-dir>/big-brother/profiles/<repo-slug>/profile.json`, keyed by the
watched repository's local git root. It names the stable wake session, the
main session's creation model, and the review layers with their models.
The profile lives under the agent dir, never inside the watched work tree:
reviewed content cannot edit the reviewer's operating rules, and the work
tree's `.big-brother` assets (ADR 0022) stay a separate concern. A
present-but-invalid profile is a loud error; the restricted review tool
boundary is never silently downgraded to a normal session.

A session becomes the repository's review main session only through an
explicit create marker (`bigBrotherReview`), not by working directory, so
an operator's interactive session in the same repository keeps the full
tool set. The marker rides the durable create command, so a respawned
worker rebuilds the same boundary. A cold wake carries no create flags;
the daemon re-derives the marker when the wake's target name equals the
profile's session name, and a file-pinned model restores over the process
environment fallback — only an explicitly flagged create model still wins.
This is a deliberate fork divergence from upstream, which let the
environment pair own the woken session's model; a discriminating
integration test pins the restoration.

Review-layer models are configuration, not agent choice: the dispatch tool
takes a layer and an immutable range, and the layer's model resolves from
the profile at spawn (still through the catalog resolution and daemon
allowlist). A fresh review session seeds its model from the profile's main
model; from creation on, the session file owns it.

RLM children spawned by a review main session keep the normal session
profile for now. Their restricted boundary arrives with the review reading
tools increment, which will carry a policy through the spawn request
instead of inheriting the parent's marker.
