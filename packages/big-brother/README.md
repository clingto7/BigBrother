# Big Brother core

This package contains the deterministic domain core for Big Brother. It has
no model, GitHub, filesystem, or database dependency.

Current public seams:

- `loadConfiguration` / `validateConfiguration`: own Big Brother control-plane
  settings such as repositories, tracked branches, polling, state namespaces,
  and environment-variable credential references. Prime runtime settings are
  passed through separately.
- `InMemoryJobStore`: test adapter for branch enrollment, repository+SHA review
  deduplication, and repository-scoped Context Ledger behavior.
- `SqliteJobStore`: persistent service-state Adapter using Node's built-in
  `node:sqlite`; it restores cursors, review jobs, and provenance-carrying
  Context Ledger decisions after restart.
- `pollRepository`: control-plane poller that consumes a GitHub Adapter,
  enqueues every commit after the branch cursor, and advances the cursor only
  after the range reaches the observed head.
- `GitHubRestAdapter`: read-only GitHub REST Adapter for branch heads and
  compare ranges. It uses injected `fetch` at the network seam and keeps the
  token in the request header only.
- `publishReviewResult`: validates and maps a review result to a non-blocking
  Commit Status, creating or updating it through the GitHub Adapter.
- `PrimeRuntimeSupervisor`: keeps one long-lived Prime runtime per repository
  and serializes review submissions until context-conflict handling exists.
- `PrimeRpcRuntimeFactory`: starts the pinned Prime bundle through its public
  JSONL RPC mode, injects the Big Brother reviewer profile, and isolates each
  repository's session and agent state namespace.
- `buildReviewInput`: creates the host-owned, immutable commit evidence packet
  passed to Prime; it never executes or interprets repository content.
- `ReviewCoordinator`: runs one admitted job through workspace materialization,
  recovered-context evidence assembly, Prime submission, Commit Status
  publication, and durable reconciliation of Prime-approved context decisions.
- `GitReviewEvidenceAdapter`: reads the fixed workspace commit, parent diff,
  message, changed paths, and policy documents with read-only Git commands.
- `createReviewerProfile`: defines the initial static, read-only system
  prompt, commit-review skill, and disabled-tool runtime flags.
- `renderLaunchdPlist` / `renderSystemdUnit`: render foreground-watch service
  definitions with explicit paths and no embedded secrets.

The poller expects `listCommits` to return commits in oldest-to-newest order,
excluding `fromSha` and including `toSha`. An incomplete range is rejected and
the cursor is left unchanged.
- `selectPolicySnapshot`: applies the parent-policy rule when a commit changes
  project policy or a repository-verifiable commit template.
- `validateReviewResult`: rejects malformed results and findings without
  evidence references.

Run the tests with:

```sh
npm test
```

The in-memory store is deliberately not the production persistence layer. The
SQLite Adapter is the first persistent implementation; the service should
place its database in the mounted state volume.

Workspace preparation is engine-neutral. Container selection belongs to the
deployment layer (`CONTAINER_ENGINE=podman` or `docker`), not this package.

The RPC factory does not invoke a model during tests. Provider authentication
and model selection belong to the independent Prime agent identity. Run
`big-brother agent`, then use Prime's `/login` and `/model`; no model setting or
credential belongs in the Big Brother repository configuration.

See [`config/big-brother.example.json`](../../config/big-brother.example.json)
for the control-plane configuration shape. Credential fields are environment
variable names, never token or key contents.

The end-to-end setup and operations guide is
[`docs/user-guide.md`](../../docs/user-guide.md).
