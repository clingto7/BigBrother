# ADR 0012: Use Commit Status as the MVP Review Surface

Status: Accepted

Date: 2026-09-14

## Context

The original design selected GitHub Check Runs, but the working MVP and its
verified live path publish an advisory Commit Status under
`big-brother/review`. Commit Status is sufficient for the initial result
surface and avoids making the first deployment depend on the more specialized
Checks credential capability. A reviewed commit still needs one idempotent,
non-blocking status and no repository-content write permission.

## Decision

GitHub Commit Status is the canonical delivery surface for the initial static
MVP. The publication credential is separate from repository read/clone
credentials and must be explicitly configured with only the required status
write capability. The publisher uses a stable context and updates it
idempotently for a repository and commit.

Check Run support may be added later as an explicit adapter and product
decision. Big Brother must not silently switch result surfaces when a future
publisher fails.

## Consequences

The MVP has a simple, verified, advisory result path with limited rich-rendering
capability. Rich annotations and detailed UI remain available as a future
Check Run decision, with its own credential and failure semantics. ADR 0006 is
retained as the historical Check Run capability decision but is superseded for
the current MVP.
