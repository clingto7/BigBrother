# ADR 0032: Configure cumulative review coverage and share range evidence

Status: Accepted

Big Brother offers four cumulative Review intensities: monitoring only;
verifiable requirements; requirements and project fit; or all three review areas,
including implementation quality. Intensity determines coverage, not the
execution budget. The selected intensity is fixed when the Review range is
admitted, so retries have the same scope. This revises ADR 0019's requirement
that every range run every layer. Repository Prime remains responsible for the
final assessment; reviewer output is evidence and proposals.

In monitoring-only mode, one notification for an observed range identifies the
Repository and lists each commit and its message. No review conclusion, Review
record, or review Commit Status is produced. Observation progress remains
durable so restarts do not repeat notifications or skip later ranges.

For reviewed ranges, the Observer constructs shared, provenance-bearing Review
evidence once per range. It includes the complete changed-file inventory and
applicable source material. OCR's deterministic file and rule selection
contributes focus hints by default; it does not restrict the Review scope.
Reviewers may inspect other repository files and history. A model-generated
project summary is not part of the initial evidence construction. The evidence
is versioned and inspectable, and its provenance is retained with the Review
record. Reviewed repository content and OCR rules never gain authority to
change the reviewer's operating instructions.

Use one reviewer child for every reviewed range. The conductor reads the
shared evidence, changed commits, and relevant project guidance first, then
passes a concise range-specific review brief to that reviewer. The reviewer
still may inspect any repository file or history. Review intensity selects
which of the three review concerns the one reviewer must cover; it does not
select reviewer count or execution budget. This supersedes ADR 0019's
one-child-per-layer topology. The paired comparison remains implementation
evidence only; no further topology-selection work is required.

The initial public review Skill is a separate, free, cross-project artifact
containing review method, evidence requirements, and result format. It does
not include Observer deployment, session supervision, or notification
management; those belong to a later Skill.
