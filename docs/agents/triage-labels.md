# Triage Labels

The skills speak in terms of five canonical triage roles. This file maps those
roles to the actual label strings used in this repo's issue tracker.

## Canonical roles

| Label in mattpocock/skills | Label in our tracker | Meaning |
| -------------------------- | -------------------- | ------- |
| `needs-triage` | `needs-triage` | Maintainer needs to evaluate this issue |
| `needs-info` | `needs-info` | Waiting on reporter for more information |
| `ready-for-agent` | `ready-for-agent` | Fully specified, ready for an AFK agent |
| `ready-for-human` | `ready-for-human` | Requires human implementation |
| `wontfix` | `wontfix` | Will not be actioned |

Every triaged issue should carry exactly one canonical category role and one
canonical state role. The labels below are additional project labels; they do
not replace the canonical state role.

## Additional project labels

| Label | Meaning |
| ----- | ------- |
| `defer` | Temporarily postponed; may be reconsidered later |
| `prone` | Potentially problematic; revisit if related failures appear |
