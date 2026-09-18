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
  "finding_issue_intents",
];

const WORKER_REQUIRED_FIELDS = REQUIRED_FIELDS.filter(
	(field) => field !== "context_decisions" && field !== "finding_issue_intents",
);

export function validateWorkerReviewResult(result) {
	const errors = [];
	if (!result || typeof result !== "object") {
		return { ok: false, errors: ["worker review result must be an object"] };
	}

	for (const field of WORKER_REQUIRED_FIELDS) {
		if (!(field in result)) errors.push(`missing field: ${field}`);
	}
	if (Array.isArray(result.context_decisions) && result.context_decisions.length > 0) {
		errors.push("worker review cannot contain context decisions");
	}
	if (Array.isArray(result.finding_issue_intents) && result.finding_issue_intents.length > 0) {
		errors.push("worker review cannot contain finding issue intents");
	}

	const validation = validateReviewResult({
		...result,
		context_decisions: [],
		finding_issue_intents: [],
	});
	errors.push(...validation.errors.filter((error) => !error.startsWith("missing field: ")));
	return { ok: errors.length === 0, errors };
}

export function assertReviewResultIdentity({ repositoryId, commitSha, reviewResult }) {
	if (
		!reviewResult ||
		reviewResult.repository_id !== repositoryId ||
		reviewResult.commit_sha !== commitSha
	) {
		throw new Error(`review result does not match review job: ${repositoryId}:${commitSha}`);
	}
}

export function validateReviewResult(result) {
  const errors = [];

  if (!result || typeof result !== "object") {
    return { ok: false, errors: ["review result must be an object"] };
  }

  for (const field of REQUIRED_FIELDS) {
    if (!(field in result)) errors.push(`missing field: ${field}`);
  }

  for (const field of ["observed_branches", "findings", "policy_checks", "evidence", "limitations", "candidate_facts", "context_decisions", "finding_issue_intents"]) {
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
  if (
    result.conclusion === "clean" &&
    Array.isArray(result.finding_issue_intents) &&
    result.finding_issue_intents.some((intent) => findingIssueIntentAction(intent) !== "resolve")
  ) {
    errors.push("clean review cannot contain active finding issue intents");
  }

  if (Array.isArray(result.findings) && Array.isArray(result.evidence)) {
    const evidenceIds = new Set(result.evidence.map((item) => item?.id));
    const findingIds = new Set();
    for (const finding of result.findings) {
      if (typeof finding?.id !== "string" || finding.id.length === 0) {
        errors.push("finding must have a non-empty stable id");
      } else if (findingIds.has(finding.id)) {
        errors.push(`duplicate finding id: ${finding.id}`);
      } else {
        findingIds.add(finding.id);
      }
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

    if (Array.isArray(result.finding_issue_intents)) {
      const intendedFindings = new Set();
      for (const intent of result.finding_issue_intents) {
        const findingId = intent?.finding_id;
        const action = findingIssueIntentAction(intent);
        if (typeof findingId !== "string" || findingId.length === 0) {
          errors.push("finding issue intent must have a non-empty finding_id");
        } else if (!(action === "resolve" || findingIds.has(findingId))) {
          errors.push(`finding issue intent cites unknown finding: ${findingId}`);
        } else if (intendedFindings.has(findingId)) {
          errors.push(`duplicate finding issue intent: ${findingId}`);
        } else {
          intendedFindings.add(findingId);
        }
        if (action !== "active" && action !== "resolve") {
          errors.push(`finding issue intent ${findingId ?? "<unknown>"} has unsupported action: ${action}`);
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

export function findingIssueIntentAction(intent) {
  return intent?.action ?? "active";
}
