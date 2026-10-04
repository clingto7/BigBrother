# Big Brother MVP

## Goal

Run a long-lived, GitHub-only code-review service that watches explicitly
configured branches, reviews each newly discovered commit, maintains canonical
repository context through Repository Prime and the Context Ledger, and
publishes an advisory Commit Status.

## Non-goals

- Modifying source files, commits, branches, or pull-request code.
- Blocking merges in the first version.
- Executing project code or installing project dependencies.
- Sending Feishu, WeChat, Bark, ntfy, RSS, or other external notifications.
- Replacing human review or claiming complete automated verification.

## Runtime boundary

The service has four logical responsibilities:

1. **Control-plane poller** periodically reads the configured GitHub branches
   and discovers new commit SHAs. It does not ask Prime to poll.
2. **Repository state** stores configuration-derived progress, idempotency
   records, review records, and durable context in service-owned persistent
   storage isolated per repository.
3. **Repository Prime** owns one long-lived project understanding for each
   configured repository. It admits commit-review workers, zooms out over
   their results, synthesizes the final review, and decides whether
   evidence-backed candidate facts are promoted into the Context Ledger.
4. **Commit-review worker** performs one bounded review of one immutable commit
   and returns findings, evidence, limitations, and candidate facts. It does
   not poll, publish, or mutate durable context directly.

The first deployment may run with one repository, but the configuration model
supports multiple repositories with independent Prime and state boundaries.

## Review flow

1. The poller reads each explicitly tracked branch.
2. A newly enrolled branch starts at its current tip and does not trigger an
   implicit historical backfill.
3. Newly discovered commits are enqueued at least once and deduplicated by
   repository plus commit SHA.
4. The service materializes and verifies the fixed commit, then builds a
   parent-owned evidence packet. The workspace itself is not passed to the
   worker.
5. The review execution supervisor starts one fresh child process for the
   attempt. The child runs the bounded Commit-review prompt through Prime's
   public JSONL RPC interface.
6. The worker checks the commit message, any repository-verifiable message
   template, documented policy, and clear correctness/security/regression
   evidence in the diff.
7. Repository Prime zooms out over the worker result, synthesizes the Review
   record, and evaluates candidate facts, preserving provenance and
   reversibility when promoting them to the Context Ledger.
8. The service publishes one non-blocking GitHub Commit Status for the commit.

If the same commit is reachable from several tracked branches, the review is
performed once and the branch associations are retained as metadata.

## Policy and context

Repository policy is resolved from the agreed project-document hierarchy. A
commit that introduces or changes a policy or message template is checked using
the parent version; the new rule applies to later commits. Repository-tracked
or otherwise repository-verifiable templates are valid review inputs; a
contributor's local Git configuration is not.

The default context is repository-wide. A branch-specific overlay is created
only when a branch has genuinely different policy or behavior. Independent
reviews may run in parallel, but durable context updates are serialized.

## Permissions and isolation

The MVP uses separate configured credentials for repository read/clone access
and GitHub Commit Status publication. Status credentials are explicitly typed
as `Commit statuses: write`; the status is advisory and has no push or
repository-content modification permission. The static review profile does not
execute code, tests, builds, scripts, or dependency installation, so it does
not require Docker or Podman. Durable state remains in a service-owned
directory; secrets are supplied by runtime configuration rather than stored in
the repository. The child receives an allowlisted process environment, no
workspace path, and no configured GitHub publication credentials. This is a
process boundary, not an OS filesystem or network sandbox: OCI isolation remains
required before enabling execution-capable tools.

## Defaults that do not need separate design decisions yet

- At-least-once polling and job delivery with idempotent processing.
- Retry failed jobs by posting the same Commit Status context.
- Preserve review and context provenance for inspection and rollback.
- Process commit ancestry in order when context dependencies require it.
- Keep findings advisory and evidence-based when execution is unavailable.

These defaults can be changed by a later ADR if the first prototype or
production operation exposes a real limitation.

## Current implementation status (2026-10-04)

- **Core control plane complete:** independent launcher and pinned
  Prime-derived runtime; validated configuration; GitHub polling and REST
  adapters; fixed-SHA workspace/evidence collection; SQLite job and context
  state; Commit Status and Prime-approved finding-issue publication.
- **Repository context complete:** Repository Prime reconciles candidate facts
  against the durable Context Ledger, with provenance, correction/retraction,
  and restart recovery covered by deterministic tests.
- **Worker lifecycle complete:** each review uses a fresh child process and a
  one-request/one-terminal JSONL protocol. The supervisor checks job, attempt,
  commit, digest, and protocol identity; handles timeout/cancellation/crash;
  records cleanup failures; and prevents failed attempts from reaching Prime
  reconciliation or publication.
- **Static review profile:** worker receives a host-built evidence packet, not
  a workspace path. Prime tools and native RLM/Pi execution remain disabled;
  project code and tests are not run.
- **OCR boundary:** review input accepts provenance-bearing external evidence
  as advisory Focus hints. Automatic OCR retrieval is not implemented; the OCR
  CI lane remains separate.
- **Deployment:** foreground watch and `launchd`/`systemd` definition renderers
  are implemented. A Linux user service on Sentry completed a real GitHub
  finding/repair cycle on an isolated test branch. The first public release
  workflow still requires its own GitHub Actions run.

The package test suite uses deterministic adapters and child-process fixtures.
It does not call a live model or GitHub API. The initial static profile does
not require a container; Podman rootless remains the reference OCI runtime for
any future execution-capable profile, with Docker compatibility.
