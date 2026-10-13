# ADR 0009: Big Brother owns a separate reviewer resource profile

## Status

Accepted

## Context

Big Brother is derived from Prime but is a separate product identity. It needs
its own review doctrine and skills while watched repositories may contain
`AGENTS.md`, `CLAUDE.md`, and other documents that are evidence for a review.
Prime can discover project context files automatically, and its native RLM
path currently depends on the `ipython` tool, which also provides host-side
Python and `bash()` execution.

The initial review boundary is static and read-only. It does not run project
code, tests, builds, scripts, package managers, or dependency installation.

## Decision

Big Brother owns a reviewer resource profile under
`packages/big-brother/resources/`:

- `system-prompt.md` defines the Big Brother coordinator role and the evidence
  boundary.
- `skills/commit-review/SKILL.md` defines the per-commit review procedure.
- the Prime adapter passes these resources explicitly and uses
  `--no-context-files` so repository documents are supplied as host-selected
  policy evidence, not implicitly elevated to runtime instructions.
- the initial profile passes `--no-tools`, disables extensions, prompt
  templates, and themes, and sets `allowRlm: false`.

The profile is a Big Brother module, not a modification to Pi, Sifu, or Prime.
Changes to this prompt or skill do not require rebuilding the Prime runtime.
The pinned Prime runtime is rebuilt only when its source, bundled dependencies,
or runtime-owned resources change.

Native Prime RLM remains the planned worker mechanism, but it is not enabled by
the static profile. Enabling it requires a separately reviewed execution
profile with a real read-only/sandboxed boundary; prompt instructions alone are
not treated as an enforcement mechanism.

## Consequences

The initial runtime can review only the input and evidence material explicitly
provided by the control plane. This is intentional: it prevents an untrusted
repository file from becoming a system instruction and keeps the no-execution
claim honest.

The future RLM/Pi worker adapter must either provide a constrained read-only
workspace/tool or run inside an execution boundary such as the later OCI
profile. It must not silently turn on Prime's unrestricted `ipython` path.
