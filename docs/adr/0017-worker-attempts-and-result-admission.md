# ADR 0017: Use one-shot worker attempts with identity-checked results

Status: Accepted  
Date: 2026-09-18

A Commit Review has one stable job identity, `(repository_id, commit_sha)`,
and each execution is a separate one-shot Worker attempt with its own
`attempt_id`. A timed-out, crashed, cancelled, or protocol-invalid worker is
not resumed; a retry starts a fresh attempt from the same immutable review
input. The result protocol is one request followed by one validated terminal
JSONL response. Partial output is never a review result.

The review execution supervisor accepts a result only when its job identity,
attempt identity, commit identity, input digest, and protocol version match the
active attempt. Late results from superseded attempts are discarded and cannot
publish, update durable context, or overwrite a newer attempt. Failure reasons
remain explicit (`timed_out`, `crashed`, `cancelled`, or `protocol_failed`) so
the control plane can apply retry and publication policy without treating a
worker failure as a clean review.

This makes long-running monitoring restart-safe for both newly enrolled and
previously monitored repositories: the repository job is durable, while every
worker execution is disposable and reproducible from its immutable input.
