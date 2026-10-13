# ADR 0022: Bootstrap project understanding in the watched working tree

Status: Accepted for the next design

An operator explicitly runs `big-brother init` in the same machine's persistent
working tree that the watcher will use. Init scans the current project state,
documents, and relevant history to create both inspectable narrative and
structured Project understanding assets under `.big-brother`; it does not
review every historical commit. Git tracking of that directory is the user's
choice. The watcher cannot start reviewing that repository until initialization
has completed.

Subsequent reviews update the assets incrementally. A separate
`big-brother index` command recalibrates the code map and document index after
major changes, proposes corrections to stale facts, and preserves confirmed
Project direction and review history while reporting conflicts. This revises
ADR 0003's storage boundary for project understanding; operational review and
delivery state remain distinct from these work-tree assets.

CodeGraph's `init`/index workflow is a product-shape reference only. The
initial implementation defines and produces Big Brother's own assets without
requiring CodeGraph, skills, or MCP integrations.

The first supported deployment is one operator on one machine, with a
persistent local working tree for each watched repository.
