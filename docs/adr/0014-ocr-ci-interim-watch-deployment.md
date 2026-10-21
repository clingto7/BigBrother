# ADR 0014: OCR CI workflow as the interim watch deployment

## Status

Accepted

## Context

Big Brother's deterministic control plane (Phase 1) is implemented, but the
Prime-led worker loop does not yet deliver live reviews on the watched
repository: a live model call still depends on operator Prime login and
network setup.

To validate an LLM review engine — its finding precision, noise level,
token cost, and failure behavior — before committing to the Prime worker
design, a push-driven GitHub Actions workflow was deployed directly on the
watched repository (`clingto7/yadig`, `.github/workflows/ocr-review.yml`).
The workflow runs OpenCodeReview (OCR) v1.12.4 in full LLM-endpoint mode
against a GLM coding-plan endpoint (`glm-5.2`), reviews the
`before..after` range of each push to the tracked branch, and publishes an
advisory Commit Status under the context `ocr/review` with sanitized
artifacts retained for 30 days.

Five review iterations over its own deployment and hardening commits
converged 8 → 5 → 3 → 1 → 0 findings, including one round that caught real
defects in the fixes themselves (regex-unsafe secret redaction, a jq escape
ambiguity). Failure modes were exercised deliberately: missing LLM
configuration, a high-severity finding, a schema-drift guard on
`comments: null`, and transient reasoning-model completion timeouts
(`OCR_LLM_TIMEOUT=900` with a 60-minute job). A single-file review consumed
roughly 70k tokens within the coding-plan subscription.

## Decision

The verified workflow is preserved verbatim as a reference artifact at
`examples/ocr-ci/ocr-review.yml`; the live instance remains deployed in the
watched repository, not in this one.

The interim deployment is outside Big Brother's runtime architecture. It
holds no repository state, has no Repository Prime or Context Ledger,
reviews push ranges rather than individual immutable commits, and covers
only the defect/security axis — not commit-message template or
project-policy compliance, and not the parent-policy rule for
policy-changing commits.

Validation evidence from its artifacts is an input to the Prime worker and
reviewer-profile design in ADR 0009; it does not modify that design.

The deployment is retired — or deliberately retained as an independent,
PR-less second lane — when the real watch service publishes Commit Statuses
for the same repository per ADR 0012. The two surfaces are distinguished by
status context: `ocr/review` versus `big-brother/review`.

## Consequences

The watched repository has interim advisory coverage today, and quality and
cost evidence accumulates in workflow artifacts without touching Big
Brother's state model or domain language.

The workflow's engine version is pinned and its maintenance is manual;
upgrading OCR is a reviewed change, not a chore.

A reader may mistake the interim deployment for Big Brother itself. This
ADR, the reference copy's README, and the distinct status context bound that
confusion: the CI workflow is a validation instrument and stopgap, not the
product.
