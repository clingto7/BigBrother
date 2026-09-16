import { CONTEXT_DECISION_ACTIONS } from "./context-ledger.mjs";

const REQUIRED_FIELDS = [
  "repository_id",
  "commit_sha",
  "parent_sha",
  "observed_branches",
  "conclusion",
  "message_check",
  "findings",
  "policy_checks",
  "evidence",
  "limitations",
  "candidate_facts",
  "context_decisions",
];

export function validateReviewResult(result) {
  const errors = [];

  if (!result || typeof result !== "object") {
    return { ok: false, errors: ["review result must be an object"] };
  }

  for (const field of REQUIRED_FIELDS) {
    if (!(field in result)) errors.push(`missing field: ${field}`);
  }

  for (const field of ["observed_branches", "findings", "policy_checks", "evidence", "limitations", "candidate_facts", "context_decisions"]) {
    if (field in result && !Array.isArray(result[field])) errors.push(`${field} must be an array`);
  }

  for (const field of ["repository_id", "commit_sha", "parent_sha"]) {
    if (field in result && (typeof result[field] !== "string" || result[field].length === 0)) {
      errors.push(`${field} must be a non-empty string`);
    }
  }

  if (
    "message_check" in result &&
    (!result.message_check || typeof result.message_check !== "object" || Array.isArray(result.message_check))
  ) {
    errors.push("message_check must be an object");
  }

  if (typeof result.conclusion !== "string" || result.conclusion.length === 0) {
    errors.push("conclusion must be a non-empty string");
  }

  if (result.conclusion === "clean" && Array.isArray(result.context_decisions) && result.context_decisions.length > 0) {
    errors.push("clean review cannot contain context decisions");
  }

  if (Array.isArray(result.findings) && Array.isArray(result.evidence)) {
    const evidenceIds = new Set(result.evidence.map((item) => item?.id));
    for (const finding of result.findings) {
      if (!Array.isArray(finding?.evidence_refs) || finding.evidence_refs.length === 0) {
        errors.push(`finding ${finding?.id ?? "<unknown>"} must cite evidence`);
        continue;
      }
      for (const evidenceRef of finding.evidence_refs) {
        if (!evidenceIds.has(evidenceRef)) {
          errors.push(`finding ${finding?.id ?? "<unknown>"} cites unknown evidence: ${evidenceRef}`);
        }
      }
    }

    if (Array.isArray(result.context_decisions)) {
      for (const decision of result.context_decisions) {
        const decisionId = decision?.id ?? "<unknown>";
        if (typeof decision?.id !== "string" || decision.id.length === 0) {
          errors.push("context decision must have a non-empty id");
        }
        if (typeof decision?.fact_id !== "string" || decision.fact_id.length === 0) {
          errors.push(`context decision ${decisionId} must have a non-empty fact_id`);
        }
        if (!CONTEXT_DECISION_ACTIONS.includes(decision?.action)) {
          errors.push(`context decision ${decisionId} has unsupported action: ${decision?.action}`);
        }
        if (typeof decision?.rationale !== "string" || decision.rationale.length === 0) {
          errors.push(`context decision ${decisionId} must have a non-empty rationale`);
        }
        if (
          (decision?.action === "admit" || decision?.action === "correct") &&
          (typeof decision?.statement !== "string" || decision.statement.length === 0)
        ) {
          errors.push(`context decision ${decisionId} must have a non-empty statement`);
        }
        if (!Array.isArray(decision?.evidence_refs) || decision.evidence_refs.length === 0) {
          errors.push(`context decision ${decisionId} must cite evidence`);
          continue;
        }
        for (const evidenceRef of decision.evidence_refs) {
          if (!evidenceIds.has(evidenceRef)) {
            errors.push(`context decision ${decisionId} cites unknown evidence: ${evidenceRef}`);
          }
        }
      }
    }
  }

  return { ok: errors.length === 0, errors };
}
