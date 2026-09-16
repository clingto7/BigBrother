# ADR 0001: Establish the GitHub Commit Review Boundary

Status: Accepted

Big Brother will initially support GitHub only. Each newly observed commit is
an independent commit review unit. A repository may have multiple explicitly
tracked branches, and new branches may be enrolled after monitoring has
started. Each newly enrolled branch follows the same current-tip baseline rule
as initial startup; it does not implicitly trigger a historical review.

Branch enrollment is explicit. If the same commit SHA is reachable from more
than one tracked branch, it is reviewed once at repository scope and its
branch associations are retained as metadata rather than creating duplicate
reviews.

A mechanical watcher/control plane is responsible for discovering repository
updates; the review agent receives a fixed commit and is not responsible for
polling GitHub. The first reviewer mode is static: it does not execute project
code or install project dependencies by default. If the repository provides a
commit message template, that template is part of the review policy. Review
records are written back as non-blocking GitHub Commit Statuses. This is a read-only
review boundary: the service does not modify repository files, commits,
branches, or pull-request code, and the first version does not act as a merge
gate. Feishu, WeChat, Bark, ntfy, RSS, and similar external notifications
remain a later delivery concern.

Only repository-tracked or otherwise repository-verifiable commit message
templates are review inputs; a contributor's local Git configuration is not.
When several repository templates are present and the applicable one cannot be
determined, the review reports the ambiguity instead of guessing.

This boundary keeps discovery deterministic, makes review jobs attributable to
one immutable revision, limits host exposure, and gives the first version one
durable result surface. It also means the system must eventually handle
idempotency and backlog for per-commit reviews, and review results must state
when the absence of execution or installed dependencies limits confidence.
For a repository with multiple active branches, independent reviews may run in
parallel, but Prime's durable-context updates are serialized according to
commit ancestry or an explicit conflict-resolution rule.
