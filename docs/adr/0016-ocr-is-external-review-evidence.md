# ADR 0016: Treat OCR output as external review evidence

Status: Accepted  
Date: 2026-09-18

OCR output is optional External review evidence for Big Brother. Its comments,
warnings, and metadata may be supplied as Focus hints to the Commit-review
worker and may help Repository Prime validate or prioritize evidence, but OCR
does not narrow or replace Big Brother's canonical Review scope. Big Brother
continues to cover its own commit-message, project-policy, and defect/security
questions independently.

An OCR result may be direct evidence for a commit only when its provenance
identifies that immutable commit. Results produced for a multi-commit push
range remain range-scoped hints unless their findings can be attributed to the
reviewed commit. OCR failures, including a null-comment failure result, are
represented as unavailable or incomplete evidence rather than as a clean
review.

This preserves the useful validation and prioritization signal from the
interim OCR deployment without making a push-oriented, defect-only tool the
authority for Big Brother's per-commit review contract.
