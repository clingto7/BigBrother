import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { InMemoryJobStore, ReviewCoordinator, SqliteJobStore } from "../src/index.mjs";

test("a completed repository cycle admits Prime-approved context and recovers it once after restart", async () => {
	const directory = mkdtempSync(join(tmpdir(), "big-brother-context-ledger-"));
	const filePath = join(directory, "state.sqlite");
	const evidence = { id: "E1", commit_sha: "commit-3", path: "docs/policy.md", line: 4 };
	const reviewResult = review({
		evidence: [evidence],
		candidate_facts: [
			{ id: "worker-only", statement: "Worker assertions are not durable by themselves", evidence_refs: ["E1"] },
		],
		context_decisions: [
			{
				id: "decision-1",
				action: "admit",
				fact_id: "fact-review-policy",
				statement: "Reviews follow docs/policy.md.",
				evidence_refs: ["E1"],
				rationale: "The repository policy states this explicitly.",
			},
		],
	});

	try {
		const firstStore = openStore(filePath);
		const coordinator = coordinatorReturning(reviewResult);
		await coordinator.process(cycleInput(firstStore));
		await coordinator.process(cycleInput(firstStore));
		firstStore.close();

		const reopenedStore = new SqliteJobStore(filePath);
		assert.deepEqual(reopenedStore.getContextLedger("acme/app"), [
			{
				factId: "fact-review-policy",
				statement: "Reviews follow docs/policy.md.",
				status: "active",
				history: [
					{
						decisionId: "decision-1",
						action: "admit",
						statement: "Reviews follow docs/policy.md.",
						rationale: "The repository policy states this explicitly.",
						source: {
							repositoryId: "acme/app",
							commitSha: "commit-3",
							reviewId: "acme/app:commit-3",
						},
						evidence: [evidence],
					},
				],
			},
		]);
		reopenedStore.close();
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
});

test("a later Prime decision corrects an existing fact while preserving its admission history", async () => {
	const store = new SqliteJobStore(":memory:");
	store.enrollBranch({ repositoryId: "acme/app", branchName: "main", headSha: "commit-1" });
	store.admitCommitReview({ repositoryId: "acme/app", commitSha: "commit-2", branchName: "main" });
	await coordinatorReturning(
		review({
			commit_sha: "commit-2",
			parent_sha: "commit-1",
			evidence: [{ id: "E1", commit_sha: "commit-2", path: "AGENTS.md" }],
			context_decisions: [decision({ id: "admit-1", action: "admit", statement: "Tests run with npm." })],
		}),
	).process(cycleInput(store, "commit-2"));

	store.admitCommitReview({ repositoryId: "acme/app", commitSha: "commit-3", branchName: "main" });
	await coordinatorReturning(
		review({
			evidence: [{ id: "E1", commit_sha: "commit-3", path: "package.json" }],
			context_decisions: [
				decision({ id: "correct-1", action: "correct", statement: "Tests run with node --test." }),
			],
		}),
	).process(cycleInput(store, "commit-3"));

	const [fact] = store.getContextLedger("acme/app");
	assert.equal(fact.statement, "Tests run with node --test.");
	assert.equal(fact.status, "active");
	assert.deepEqual(
		fact.history.map(({ decisionId, action, statement, source }) => ({ decisionId, action, statement, commitSha: source.commitSha })),
		[
			{ decisionId: "admit-1", action: "admit", statement: "Tests run with npm.", commitSha: "commit-2" },
			{ decisionId: "correct-1", action: "correct", statement: "Tests run with node --test.", commitSha: "commit-3" },
		],
	);
	store.close();
});

test("later Prime decisions can supersede or retract active facts without erasing history", async () => {
	const store = new SqliteJobStore(":memory:");
	store.enrollBranch({ repositoryId: "acme/app", branchName: "main", headSha: "commit-1" });
	store.admitCommitReview({ repositoryId: "acme/app", commitSha: "commit-2", branchName: "main" });
	await coordinatorReturning(
		review({
			commit_sha: "commit-2",
			parent_sha: "commit-1",
			evidence: [{ id: "E1", commit_sha: "commit-2", path: "README.md" }],
			context_decisions: [
				decision({ id: "admit-old", action: "admit", factId: "fact-old", statement: "The old rule applies." }),
				decision({ id: "admit-wrong", action: "admit", factId: "fact-wrong", statement: "A mistaken rule applies." }),
			],
		}),
	).process(cycleInput(store, "commit-2"));

	store.admitCommitReview({ repositoryId: "acme/app", commitSha: "commit-3", branchName: "main" });
	await coordinatorReturning(
		review({
			evidence: [{ id: "E1", commit_sha: "commit-3", path: "README.md" }],
			context_decisions: [
				decision({ id: "supersede-old", action: "supersede", factId: "fact-old" }),
				decision({ id: "retract-wrong", action: "retract", factId: "fact-wrong" }),
			],
		}),
	).process(cycleInput(store, "commit-3"));

	assert.deepEqual(
		store.getContextLedger("acme/app").map(({ factId, status, history }) => ({
			factId,
			status,
			actions: history.map(({ action }) => action),
		})),
		[
			{ factId: "fact-old", status: "superseded", actions: ["admit", "supersede"] },
			{ factId: "fact-wrong", status: "retracted", actions: ["admit", "retract"] },
		],
	);
	store.close();
});

test("an invalid Prime decision fails the repository cycle without changing durable context", async () => {
	const store = new SqliteJobStore(":memory:");
	store.enrollBranch({ repositoryId: "acme/app", branchName: "main", headSha: "commit-2" });
	store.admitCommitReview({ repositoryId: "acme/app", commitSha: "commit-3", branchName: "main" });
	const result = review({
		context_decisions: [
			{
				id: "invalid-admission",
				action: "admit",
				fact_id: "fact-unsupported",
				statement: "An unsupported assertion.",
				evidence_refs: ["missing"],
				rationale: "No matching evidence exists.",
			},
		],
	});

	await assert.rejects(coordinatorReturning(result).process(cycleInput(store)), /invalid review result.*context decision/i);
	assert.deepEqual(store.getContextLedger("acme/app"), []);
	store.close();
});

test("a publication failure leaves the Context Ledger unchanged", async () => {
	const store = new SqliteJobStore(":memory:");
	store.enrollBranch({ repositoryId: "acme/app", branchName: "main", headSha: "commit-2" });
	store.admitCommitReview({ repositoryId: "acme/app", commitSha: "commit-3", branchName: "main" });
	const result = review({
		evidence: [{ id: "E1", commit_sha: "commit-3", path: "README.md" }],
		context_decisions: [
			decision({ id: "unpublished-admit", action: "admit", factId: "fact-unpublished", statement: "Not completed." }),
		],
	});
	const failingPublisher = async () => {
		throw new Error("publication failed");
	};

	await assert.rejects(
		coordinatorReturning(result, [], failingPublisher).process(cycleInput(store)),
		/publication failed/,
	);
	assert.deepEqual(store.getContextLedger("acme/app"), []);
	store.close();
});

test("Ledger reconciliation rejects impossible transitions atomically", async () => {
	const store = new SqliteJobStore(":memory:");
	store.enrollBranch({ repositoryId: "acme/app", branchName: "main", headSha: "commit-2" });
	store.admitCommitReview({ repositoryId: "acme/app", commitSha: "commit-3", branchName: "main" });
	const result = review({
		evidence: [{ id: "E1", commit_sha: "commit-3", path: "README.md" }],
		context_decisions: [
			decision({ id: "admit-valid", action: "admit", factId: "fact-valid", statement: "A valid fact." }),
			decision({ id: "correct-missing", action: "correct", factId: "fact-missing", statement: "No fact exists." }),
		],
	});

	await assert.rejects(coordinatorReturning(result).process(cycleInput(store)), /cannot correct unknown fact: fact-missing/i);
	assert.deepEqual(store.getContextLedger("acme/app"), []);
	store.close();
});

test("worker-only candidate facts and clean reviews leave the Context Ledger unchanged", async () => {
	const store = new SqliteJobStore(":memory:");
	store.enrollBranch({ repositoryId: "acme/app", branchName: "main", headSha: "commit-1" });
	store.admitCommitReview({ repositoryId: "acme/app", commitSha: "commit-2", branchName: "main" });
	await coordinatorReturning(
		review({
			commit_sha: "commit-2",
			parent_sha: "commit-1",
			evidence: [{ id: "E1", commit_sha: "commit-2", path: "README.md" }],
			candidate_facts: [{ id: "worker-1", statement: "Unadmitted worker claim", evidence_refs: ["E1"] }],
		}),
	).process(cycleInput(store, "commit-2"));
	store.admitCommitReview({ repositoryId: "acme/app", commitSha: "commit-3", branchName: "main" });
	await coordinatorReturning(review({ conclusion: "clean" })).process(cycleInput(store, "commit-3"));

	assert.deepEqual(store.getContextLedger("acme/app"), []);
	store.close();
});

test("the in-memory Job Store exposes the same repository-cycle Ledger behavior", async () => {
	const store = new InMemoryJobStore();
	store.enrollBranch({ repositoryId: "acme/app", branchName: "main", headSha: "commit-2" });
	store.admitCommitReview({ repositoryId: "acme/app", commitSha: "commit-3", branchName: "main" });
	await coordinatorReturning(
		review({
			evidence: [{ id: "E1", commit_sha: "commit-3", path: "README.md" }],
			context_decisions: [
				decision({ id: "memory-admit", action: "admit", factId: "fact-memory", statement: "Memory fact." }),
			],
		}),
	).process(cycleInput(store));

	assert.deepEqual(store.getContextLedger("acme/app").map(({ factId, statement, status }) => ({ factId, statement, status })), [
		{ factId: "fact-memory", statement: "Memory fact.", status: "active" },
	]);
});

test("the next repository cycle receives recovered active Ledger context", async () => {
	const store = new SqliteJobStore(":memory:");
	store.enrollBranch({ repositoryId: "acme/app", branchName: "main", headSha: "commit-1" });
	store.admitCommitReview({ repositoryId: "acme/app", commitSha: "commit-2", branchName: "main" });
	await coordinatorReturning(
		review({
			commit_sha: "commit-2",
			parent_sha: "commit-1",
			evidence: [{ id: "E1", commit_sha: "commit-2", path: "README.md" }],
			context_decisions: [
				decision({ id: "recover-admit", action: "admit", factId: "fact-recovered", statement: "Recovered fact." }),
			],
		}),
	).process(cycleInput(store, "commit-2"));

	store.admitCommitReview({ repositoryId: "acme/app", commitSha: "commit-3", branchName: "main" });
	const submittedInputs = [];
	await coordinatorReturning(review(), submittedInputs).process(cycleInput(store, "commit-3"));

	assert.deepEqual(
		submittedInputs[0].canonical_context.map(({ factId, statement, status }) => ({ factId, statement, status })),
		[{ factId: "fact-recovered", statement: "Recovered fact.", status: "active" }],
	);
	store.close();
});

function openStore(filePath) {
	const store = new SqliteJobStore(filePath);
	store.enrollBranch({ repositoryId: "acme/app", branchName: "main", headSha: "commit-2" });
	store.admitCommitReview({ repositoryId: "acme/app", commitSha: "commit-3", branchName: "main" });
	return store;
}

function coordinatorReturning(reviewResult, submittedInputs = [], publisher = async () => ({ id: 7 })) {
	return new ReviewCoordinator({
		workspaceManager: {
			async materialize({ commitSha }) {
				return { directory: `/work/${commitSha}`, commitSha };
			},
		},
		runtimeSupervisor: {
			async start() {
				return { repositoryId: "acme/app" };
			},
			async submitReview(_handle, input) {
				submittedInputs.push(structuredClone(input));
				return structuredClone(reviewResult);
			},
		},
		evidenceProvider: async () => ({
			parentSha: reviewResult.parent_sha,
			commit: { message: "docs: clarify policy" },
			changedPaths: ["docs/policy.md"],
			diff: "diff",
			policySnapshot: {},
		}),
		publisher,
	});
}

function cycleInput(store, commitSha = "commit-3") {
	return {
		repositoryProfile: {
			repositoryId: "acme/app",
			cloneUrl: "https://github.com/acme/app.git",
			stateNamespace: "/state/acme-app",
		},
		job: { repositoryId: "acme/app", commitSha, observedBranches: ["main"] },
		github: {},
		store,
	};
}

function decision({ id, action, factId = "fact-test-command", statement }) {
	return {
		id,
		action,
		fact_id: factId,
		statement,
		evidence_refs: ["E1"],
		rationale: "Prime reconciled repository evidence.",
	};
}

function review(overrides = {}) {
	return {
		repository_id: "acme/app",
		commit_sha: "commit-3",
		parent_sha: "commit-2",
		observed_branches: ["main"],
		conclusion: "findings",
		message_check: { status: "pass" },
		findings: [],
		policy_checks: [],
		evidence: [],
		limitations: [],
		candidate_facts: [],
		context_decisions: [],
		...overrides,
	};
}
