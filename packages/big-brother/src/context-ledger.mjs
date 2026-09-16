export const CONTEXT_DECISION_ACTIONS = Object.freeze(["admit", "correct", "supersede", "retract"]);

export function buildContextDecisionRecords({ repositoryId, commitSha, reviewResult }) {
	if (reviewResult.repository_id !== repositoryId || reviewResult.commit_sha !== commitSha) {
		throw new Error("context decision source does not match the repository cycle");
	}
	const evidenceById = new Map(reviewResult.evidence.map((item) => [item?.id, item]));
	return reviewResult.context_decisions.map((decision) => ({
		repositoryId,
		decisionId: decision.id,
		factId: decision.fact_id,
		action: decision.action,
		statement: decision.statement,
		rationale: decision.rationale,
		source: { repositoryId, commitSha, reviewId: `${repositoryId}:${commitSha}` },
		evidence: structuredClone(decision.evidence_refs.map((id) => evidenceById.get(id))),
	}));
}

export function reconcileContextDecisionRecords(existingRecords, proposedRecords) {
	const decisions = new Map(existingRecords.map((record) => [record.decisionId, record]));
	const facts = new Map(reduceContextLedger(existingRecords).map((fact) => [fact.factId, fact]));
	const additions = [];

	for (const record of proposedRecords) {
		const existing = decisions.get(record.decisionId);
		if (existing) {
			if (JSON.stringify(existing) !== JSON.stringify(record)) {
				throw new Error(`context decision id was reused with different content: ${record.decisionId}`);
			}
			continue;
		}

		const fact = facts.get(record.factId);
		if (record.action === "admit") {
			if (fact) throw new Error(`cannot admit existing fact: ${record.factId}`);
		} else if (!fact) {
			throw new Error(`cannot ${record.action} unknown fact: ${record.factId}`);
		} else if (fact.status !== "active") {
			throw new Error(`cannot ${record.action} ${fact.status} fact: ${record.factId}`);
		}

		additions.push(record);
		decisions.set(record.decisionId, record);
		facts.set(record.factId, currentFact(record, fact));
	}

	return additions;
}

export function reduceContextLedger(records) {
	const facts = new Map();
	for (const record of records) {
		const fact = facts.get(record.factId) ?? {
			factId: record.factId,
			statement: undefined,
			status: "active",
			history: [],
		};
		Object.assign(fact, currentFact(record, fact));
		fact.history.push({
			decisionId: record.decisionId,
			action: record.action,
			statement: record.statement,
			rationale: record.rationale,
			source: structuredClone(record.source),
			evidence: structuredClone(record.evidence),
		});
		facts.set(record.factId, fact);
	}
	return [...facts.values()];
}

function currentFact(record, previous) {
	return {
		factId: record.factId,
		statement: record.statement ?? previous?.statement,
		status: record.action === "supersede" ? "superseded" : record.action === "retract" ? "retracted" : "active",
	};
}
