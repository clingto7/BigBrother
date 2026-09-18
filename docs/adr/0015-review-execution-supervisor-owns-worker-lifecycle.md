# ADR 0015: Let the review execution supervisor own worker lifecycle

Status: Accepted  
Date: 2026-09-18

Big Brother's review execution supervisor owns the operational lifecycle of
each worker attempt: process startup, timeout, cancellation, retry, crash
detection, orphan recovery, and temporary-resource cleanup. Repository Prime
owns the semantic boundary instead: it provides or evaluates repository
context, reconciles the worker proposal, and remains the only component that
can produce the final Review record or decide Context Ledger admission. The
worker cannot publish GitHub results, mutate the Context Ledger, or receive
GitHub publication credentials.

The first deterministic child-worker prototype will receive a host-built
evidence packet and will not receive a workspace path. A later execution
profile may expose a repository snapshot only through an actual read-only
execution boundary with separate scratch storage and no service credentials;
filesystem mode bits or prompt instructions alone are not treated as
isolation.

This separates model-level authority from process-level supervision. It keeps
timeouts, cancellation, retries, and failure states visible to the durable
control plane while allowing Prime and the worker runtime to evolve behind an
adapter.
