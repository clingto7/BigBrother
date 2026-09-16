# ADR 0010: Prime owns model and provider authentication

- Status: accepted
- Date: 2026-09-04

## Context

Big Brother is an independent Prime-derived agent with a deterministic GitHub
control plane. The control plane needs to start long-lived Prime RPC workers,
but the user also needs a normal agent-shaped entry point for provider login and
model selection. Duplicating Prime's provider/model configuration in
`config/big-brother.json` would create a second configuration authority and
make interactive Prime authentication inconsistent with watch mode.

## Decision

Prime owns provider selection, model selection, OAuth/API-key authentication,
and the agent identity directory. Big Brother's repository configuration owns
only GitHub monitoring/publishing settings and references to GitHub credentials.
It rejects `provider` and `model` repository fields rather than silently
accepting a competing configuration path.

`big-brother agent` starts the pinned Prime bundle with Big Brother's reviewer
profile. The operator uses Prime's `/login` and `/model` commands. The
long-lived RPC workers inherit the same Big Brother agent directory, while
their conversation/session directories remain isolated per repository under
that repository's `stateNamespace`.

## Consequences

- A model change is made once through Prime and is available to all watched
  repositories using that Big Brother identity.
- Authentication secrets remain in Prime's own auth storage or its supported
  runtime secret mechanism, not in Big Brother configuration or source control.
- Per-repository model selection is intentionally deferred; it can be added
  later only as an explicit Prime runtime/profile design.
- A deployment must ensure the interactive setup command and the long-running
  watcher use the same `BIG_BROTHER_CODING_AGENT_DIR`.
