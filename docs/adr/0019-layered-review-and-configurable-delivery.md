# ADR 0019: Use layered reviewers and configurable automatic delivery

Status: Accepted for the next design

For each Review range, Big Brother dispatches child reviewers across levels of
assessment: verifiable syntax, formatting, and commit-message requirements;
fit with documented project rules and direction; and quality of the chosen
implementation. The repository's main agent combines their results with code
evidence and owns the final judgment and project-context updates. This keeps
specialized proposals separate from the authoritative synthesis and lets the
product distinguish hard violations from higher-level advice.

Every layer runs for a range, even if another layer finds a hard violation;
the final synthesis presents hard failures separately from higher-level
assessment. An implementation-quality suggestion alone is advisory by default:
it does not mark the Commit Status as a defect or create a finding Issue.
Each layer is a distinct child-agent role and may use a separately selected
model.
Each repository may set a model-cost ceiling for a range. All layers still
receive coverage, but the agent may reduce depth as it approaches the ceiling;
any unfinished assessment is explicit and cannot be reported as a clean pass.

After synthesis, Big Brother automatically delivers results through the
channels enabled by the operator. A GitHub Commit Status for a range attaches
to its head commit; the complete record retains attribution to every commit
in the range. External channels such as Feishu, Bark, and RSS are selectable
delivery surfaces rather than independent review authorities.
