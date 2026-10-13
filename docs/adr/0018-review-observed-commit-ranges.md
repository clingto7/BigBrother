# ADR 0018: Synthesize reviews for observed commit ranges

Status: Accepted for the next design

Big Brother's next product direction treats the change from the last reviewed
revision to an observed branch head as one default Review range, even when
several commits were pushed between observations. The final review synthesis
covers the range while retaining attribution to its individual commits. This
gives users one coherent assessment of the change they encounter and makes
the review boundary reproducible from two revisions. It supersedes ADR 0001's
per-commit review-unit decision; the beta implementation still uses individual
commit jobs until the new design is implemented.

If the tracked branch advances while a range is under review, that range is
completed and retained before the next range is reviewed. A later head does
not silently replace work already in progress.
