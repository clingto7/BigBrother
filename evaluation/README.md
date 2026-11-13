# Historical reviewer topology comparison

ADR 0032 now selects one comprehensive reviewer for all new ranges. Existing
paired outputs document the earlier comparison only. This runner's layered
variant is incompatible with the selected architecture and must not be rerun;
build a single-only quality evaluation before collecting more samples.

`compare.py run` is disabled because its layered arm would now be normalized
to one reviewer, producing a false comparison. Existing output directories
remain usable with `compare.py score`. A later single-only evaluator should
measure finding quality, tokens, elapsed time, and provider billing without
comparing reviewer topologies.

Before scoring, an evaluator should inspect the original range checkout and
the later fix/verifier named in `corpus.json`, then give an independent
adjudicator only the randomly named `*-review.txt` files and case IDs. The
later fixes are evaluation references only; the reviewers never receive them
as prompts. Keep `blinded.json` from the adjudicator until judgments are
finalized: it maps random output IDs to topology. Create `judgments.json` with an object keyed by
blind ID, each containing `detectedDefectIds` (array), `falsePositiveCount`
(nonnegative integer), and `status` (`adjudicated` or `disputed`). Run
`compare.py score --output ... --judgments ...` for quality-first metrics.
Unknown-control cases are never counted as clean without adjudication. The
historical score is not used to re-open the topology decision in ADR 0032.

Historical heads may need an older toolchain. A replay failure is recorded as
incomplete, not turned into a clean verdict. This runner does not build the
historical code; it runs the current Big Brother against historical checkout
content, which is the review product's normal boundary.
