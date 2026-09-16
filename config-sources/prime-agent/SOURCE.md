# Prime Agent Source Snapshot

This directory contains the source files used to derive Big Brother's Phase 0
runtime. It was copied from the local Prime Agent checkout at:

`/Users/m1zu/ws/prime-agent`

- Upstream revision: `5b6c0e94e2f6`
- Prime version: `0.8.1`
- Runtime source: `packages/coding-agent/src/`
- RLM source: `prime-agent-runtime/`
- Resource source: `packages/coding-agent/skills/`

The active runtime under `runtime/` is a copied build output from this
revision. Update the snapshot and runtime deliberately, then re-run the
identity and isolation checks. Do not modify the upstream checkout as part of
Big Brother development.
