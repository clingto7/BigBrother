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
4. The service materializes the fixed commit and its parent diff in the
   sandboxed runtime.
5. Repository Prime provides the applicable project policy and canonical
   context to an isolated Commit-review worker.
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
the repository. OCI isolation remains a future option for execution-capable
profiles.

## Defaults that do not need separate design decisions yet

- At-least-once polling and job delivery with idempotent processing.
- Retry failed jobs by posting the same Commit Status context.
- Preserve review and context provenance for inspection and rollback.
- Process commit ancestry in order when context dependencies require it.
- Keep findings advisory and evidence-based when execution is unavailable.

These defaults can be changed by a later ADR if the first prototype or
production operation exposes a real limitation.

## Current implementation status

- Phase 0 is complete: the independent `big-brother` launcher and pinned
  Prime-derived runtime are present under `bin/`, `runtime/`, and
  `config-sources/prime-agent/`.
- Phase 1 is started: the deterministic core package under
  `packages/big-brother/` covers branch baseline enrollment, repository+SHA
  job deduplication, parent-policy selection, review-result validation, and
  cursor-based commit discovery behind a GitHub Adapter seam. A native
  `fetch`-based GitHub REST Adapter and non-blocking Commit Status Publisher are
  also covered by contract tests. Node's built-in SQLite provides the first
  persistent Job Store Adapter.
- Workspace materialization, Prime job delivery, failed-attempt recovery, and
  the foreground continuous watch loop are implemented. Platform service
  definition renderers for macOS `launchd` and Linux `systemd` are also
  implemented; activating them remains an operator deployment step.

- The Big Brother-owned static reviewer profile is now present under
  `packages/big-brother/resources/`. It supplies the system prompt and
  commit-review skill, disables automatic project-context loading and tools,
  and deliberately leaves native RLM disabled until a constrained execution
  profile is designed.

- `PrimeRpcRuntimeFactory` now connects that profile to the pinned Prime bundle
  through the public JSONL RPC mode. It is tested with an injected client;
  production host-generated evidence packing and full Prime-ledger recovery
  remain to be implemented.

- `buildReviewInput` now defines the host-owned evidence packet for one fixed
  commit, including parent, diff, policy snapshot, canonical context,
  workspace identity, and explicit no-execution constraints.

- `ReviewCoordinator` now provides the first deterministic one-job orchestration
  seam. Tests use injected adapters and do not call a model.

- `GitReviewEvidenceAdapter` now provides the first concrete evidence provider:
  it reads commit metadata/diff and policy documents from the verified detached
  workspace, applying the parent-policy rule for policy-changing commits.

- The control-plane configuration loader now validates GitHub repositories,
  tracked branches, polling, state namespaces, and environment-variable
  credential references without accepting secret values or Prime provider/model
  settings in the configuration object.

- The project now exposes a direct `big-brother` CLI through the package `bin`
  entry. `npm link ./packages/big-brother` installs the local command, and
  Bash/Zsh/Fish completion scripts are available through
  `big-brother completion <shell>`.

The Prime Runtime Supervisor and its production RPC factory are now connected
to the pinned Prime runtime without exposing Prime's private protocol. A live
model call still depends on the operator's Prime login and network setup.

The sandbox decision is recorded in ADR 0008: the initial static profile does
not require a container. Podman rootless remains the reference OCI runtime for
future execution-capable profiles, with Docker compatibility. Neither engine
is started by the development tests.
