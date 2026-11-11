# Reviewer topology comparison

`compare.py` replays each corpus range twice through the actual `big-brother
init` → Observer → Review record path. Each range uses one temporary Git root
and two separate agent directories, so both variants receive the same bounded
range and an evidence file whose bytes are checked for equality. The layered
variant assigns the same model to all three reviewers; the single variant
assigns that model to one `comprehensive` reviewer. Repository Prime uses the
same model in both. Runs are sequential to avoid sharing a live worktree. The
temporary remote contains only the historical head and its ancestors, so the
reviewer cannot inspect future fixes through another branch.

Build `big-brother` and `pa-daemon` first. Supply a configured agent directory
containing `models.json` or `auth.json` (and optionally `settings.json`) with the
chosen provider. The runner copies these files into private temporary
directories with restrictive permissions and does not put them in the output.
It will make real model calls and incur cost. Three repeated samples per range
are the default; `--case` and `--repetitions` support bounded smoke runs.

```
python3 evaluation/compare.py run \
  --source . --agent-template ~/.prime/agent \
  --model provider/model --big-brother target/debug/big-brother \
  --daemon target/debug/pa-daemon --output /path/to/evaluation-output
```

The output contains one JSON run record per variant, the immutable evidence,
final Review records, and full session JSONL for independent inspection.
Each run records elapsed wall time, request count, raw token buckets, and
catalog-estimated cost from usage rows. Provider-billed cost remains `null`
unless billing data is independently matched. Failure and timeout remain
explicit outcomes. The runner refuses an evidence byte mismatch.

Before scoring, an evaluator should inspect the original range checkout and
the later fix/verifier named in `corpus.json`, then give an independent
adjudicator only the randomly named `*-review.txt` files and case IDs. The
later fixes are evaluation references only; the reviewers never receive them
as prompts. Keep `blinded.json` from the adjudicator until judgments are
finalized: it maps random output IDs to topology. Create `judgments.json` with an object keyed by
blind ID, each containing `detectedDefectIds` (array), `falsePositiveCount`
(nonnegative integer), and `status` (`adjudicated` or `disputed`). Run
`compare.py score --output ... --judgments ...` for quality-first metrics.
Unknown-control cases are never counted as clean without adjudication. No
topology default is selected by the runner.

Historical heads may need an older toolchain. A replay failure is recorded as
incomplete, not turned into a clean verdict. This runner does not build the
historical code; it runs the current Big Brother against historical checkout
content, which is the review product's normal boundary.
