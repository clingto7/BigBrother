# OCR CI review — interim watch deployment (reference copy)

This directory preserves the verified reference copy of the interim
deployment described in [ADR 0014](../../docs/adr/0014-ocr-ci-interim-watch-deployment.md).
The live instance runs in the watched repository
(`clingto7/yadig`, `.github/workflows/ocr-review.yml`), not here.

## What it does

- Trigger: every push to the tracked branch (`main`) of the watched
  repository.
- Engine: OpenCodeReview (OCR) v1.12.4 in full LLM-endpoint mode
  (deterministic file selection + rule routing + LLM agent).
- Unit: the push's `before..after` commit range (merge-base semantics);
  falls back to a single-commit review when the previous tip is
  unavailable (force push), and says so in the status description.
- Delivery: one advisory GitHub Commit Status under context `ocr/review`
  (distinct from Big Brother's planned `big-brother/review`), a findings
  table in the job summary, and result/stderr artifacts retained 30 days.
- Secrets hygiene: the LLM endpoint URL and token are redacted from stderr
  and the result JSON inside the review step, which is their only
  consumer; later steps hold no secrets.

## Required repository configuration

| Type | Name | Value |
|---|---|---|
| secret | `OCR_LLM_URL` | LLM endpoint (validated: `https://open.bigmodel.cn/api/coding/paas/v4`) |
| secret | `OCR_LLM_TOKEN` | API key (GLM coding-plan key; pay-as-you-go keys get error 1113) |
| variable | `OCR_LLM_MODEL` | model name (validated: `glm-5.2`) |
| variable | `OCR_LLM_PROTOCOL` | `openai` (or `anthropic` / `openai-responses`) |

## Validated behavior

Five self-review iterations over its own deployment commits converged
8 → 5 → 3 → 1 → 0 findings, exercising: error status on missing LLM
configuration, failure status on high-severity findings, schema guard on
`comments: null`, transient reasoning-model completion timeouts
(`OCR_LLM_TIMEOUT=900`, job `timeout-minutes: 60`), and secret redaction.
A single-file review consumed ~70k tokens on the GLM coding plan.

## Maintenance

The engine version is pinned (`1.12.4`). Raising it is a reviewed change,
not a chore — the workflow executes the package with access to the LLM
secrets. Deleting this directory does not affect the live deployment.
