# ADR 0032: Configure cumulative review coverage and share range evidence

Status: Accepted for the next design

Big Brother offers four cumulative Review intensities: monitoring only;
verifiable requirements; requirements and project fit; or all three layers,
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

One reviewer covering the selected intensity and distinct reviewer roles are
both candidate execution designs. The default is deferred until comparison on
real, nontrivial code changes. A cheaper design is rejected if it consistently
misses serious findings caught by the baseline. Compare finding quality and
coverage before model requests, tokens, and billed cost. This also defers ADR
0019's one-child-per-layer rule pending evidence.

The initial public review Skill is a separate, free, cross-project artifact
containing review method, evidence requirements, and result format. It does
not include Observer deployment, session supervision, or notification
management; those belong to a later Skill.
