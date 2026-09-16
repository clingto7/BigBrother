# ADR 0003: Persist Service State and Poll Separately

Status: Accepted

Big Brother will keep durable Repository state in service-owned persistent
storage, isolated per repository and separate from the watched source
repository. A mechanical control-plane poller will periodically inspect every
explicitly tracked GitHub branch and create work for newly discovered commits;
Prime will not poll GitHub itself. The first version will use least-privilege
GitHub access sufficient to read repository state and publish Commit Statuses, with
no permission to push or modify repository content.

The poller may deliver the same commit more than once. Job creation and review
execution will therefore be idempotent at repository-and-commit scope. A
repository-wide context is the default; branch-specific overlays are created
only when branch policy or behavior genuinely differs. Independent branch
reviews may run in parallel, while durable context updates are serialized.

Repository Prime may autonomously decide whether a worker's result becomes
part of canonical project context.
Automatic promotion requires verifiable provenance such as a source commit,
path, documented rule, or observed code behavior. Unsupported assertions stay
local to the review result and are not promoted as durable facts.

Context facts are represented as traceable, reversible records rather than
irreversible overwrites. A commit that introduces or changes a message
template is judged using the parent version; the new template applies to later
commits. The first version's Commit Statuses are advisory and do not block merging.

This makes restarts recoverable, keeps the watched repository free of service
state, and prevents the reviewer from becoming its own discovery mechanism. It
also requires durable progress tracking, idempotent job creation, provenance
records, and a way to inspect or roll back context decisions when an automatic
judgment is later found to be wrong.
