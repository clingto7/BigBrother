# ADR 0002: Let Prime Own Repository Context

Status: Accepted

Big Brother will use one long-lived Repository Prime per Repository to maintain
the repository's project understanding. For each Commit Review, Repository
Prime may launch an isolated Commit-review worker dedicated to that fixed
commit. The worker receives the relevant policy and context, returns findings
plus candidate project facts, and does not poll GitHub, publish results, or
mutate the Context Ledger. Repository Prime zooms out from the worker result,
checks it against the wider project context, synthesizes the final Review
record, and decides what facts are trustworthy enough to admit to the Ledger.

This separates long-lived project understanding from bounded review work. It
allows review workers to be replaced, retried, or run with different prompts
without making their temporary reasoning the repository's memory. The Context
Ledger is the durable authority for accepted facts; a Prime session is useful
working memory but is reconstructible. The design requires explicit handling
of worker failure, duplicate jobs, stale context, and serialization or
conflict resolution when several commits are awaiting review.
