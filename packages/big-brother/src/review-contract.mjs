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
];

export function validateReviewResult(result) {
  const errors = [];

  if (!result || typeof result !== "object") {
    return { ok: false, errors: ["review result must be an object"] };
  }

  for (const field of REQUIRED_FIELDS) {
    if (!(field in result)) errors.push(`missing field: ${field}`);
  }

  for (const field of ["observed_branches", "findings", "policy_checks", "evidence", "limitations", "candidate_facts"]) {
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
  }

  return { ok: errors.length === 0, errors };
}
