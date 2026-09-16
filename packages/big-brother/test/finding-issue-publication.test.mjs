import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ReviewCoordinator, SqliteJobStore, runRepositoryCycle } from "../src/index.mjs";

test("a completed repository cycle publishes and durably maps a Prime-approved finding issue", async () => {
	const store = preparedStore();
	const calls = [];
	const github = {
		async createCommitStatus(input) {
			calls.push(["status", input]);
			return { id: 7 };
		},
		async createIssue(input) {
			calls.push(["issue", input]);
			return { number: 42, html_url: "https://github.com/acme/app/issues/42" };
		},
	};

	const result = await coordinatorReturning(actionableReview()).process(cycleInput(store, github));

	assert.deepEqual(calls.map(([operation]) => operation), ["status", "issue"]);
	assert.deepEqual(calls[1][1], {
		repositoryId: "acme/app",
		title: "Null authorization bypass",
		body: [
			"<!-- big-brother-finding-id: auth-null-bypass -->",
			"**Stable finding ID:** `auth-null-bypass`",
			"**Reviewed commit:** `commit-3`",
			"",
			"## Finding",
			"A null role bypasses the authorization guard.",
			"",
			"## Evidence",
			"- `src/auth.mjs:18` — The null branch returns before authorization is checked.",
			"",
			"## Limitations",
			"- Static review did not execute the authorization suite.",
		].join("\n"),
		labels: ["big-brother", "security"],
	});
	assert.deepEqual(result.findingIssues, [
		{
			repositoryId: "acme/app",
			findingId: "auth-null-bypass",
			issueNumber: 42,
			issueUrl: "https://github.com/acme/app/issues/42",
			status: "published",
			lastError: undefined,
		},
	]);
	assert.deepEqual(store.getFindingIssue({ repositoryId: "acme/app", findingId: "auth-null-bypass" }), {
		repositoryId: "acme/app",
		findingId: "auth-null-bypass",
		issueNumber: 42,
		issueUrl: "https://github.com/acme/app/issues/42",
		status: "published",
		lastError: undefined,
	});
	store.close();
});

test("repeating a repository cycle after restart reuses the durable finding issue mapping", async () => {
	const directory = mkdtempSync(join(tmpdir(), "big-brother-finding-issue-"));
	const filePath = join(directory, "state.sqlite");
	let creations = 0;
	const github = {
		async createCommitStatus() {
			return { id: 7 };
		},
		async createIssue() {
			creations += 1;
			return { number: 42, html_url: "https://github.com/acme/app/issues/42" };
		},
	};

	try {
		const firstStore = preparedStore(filePath);
		await coordinatorReturning(actionableReview()).process(cycleInput(firstStore, github));
		firstStore.close();

		const reopenedStore = new SqliteJobStore(filePath);
		const result = await coordinatorReturning(actionableReview()).process(cycleInput(reopenedStore, github));

		assert.equal(creations, 1);
		assert.equal(result.findingIssues[0].issueNumber, 42);
		reopenedStore.close();
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
});

test("an Issues permission failure leaves Commit Status published and records a retryable failure", async () => {
	const store = preparedStore();
	let statuses = 0;
	const submissions = [];
	const github = {
		async createCommitStatus() {
			statuses += 1;
			return { id: 7 };
		},
		async createIssue() {
			throw new Error("GitHub API request failed (403): Resource not accessible by personal access token");
		},
	};

	const service = repositoryService({ store, github, submissions });
	const firstCycle = await runRepositoryCycle(service);
	const failedPublication = store.getFindingIssue({ repositoryId: "acme/app", findingId: "auth-null-bypass" });

	assert.equal(statuses, 1);
	assert.deepEqual(firstCycle, {
		branches: 1,
		discovered: 0,
		processed: 1,
		failed: 0,
		retriedFindingIssues: 0,
		findingIssueFailures: [
			{
				findingId: "auth-null-bypass",
				lastError: "GitHub Review finding issue publication failed (403): Resource not accessible by personal access token",
			},
		],
	});
	assert.deepEqual(failedPublication, {
		repositoryId: "acme/app",
		findingId: "auth-null-bypass",
		issueNumber: undefined,
		issueUrl: undefined,
		status: "failed",
		lastError: "GitHub Review finding issue publication failed (403): Resource not accessible by personal access token",
	});
	github.createIssue = async () => ({ number: 42, html_url: "https://github.com/acme/app/issues/42" });
	github.findIssueByFindingId = async () => undefined;
	const secondCycle = await runRepositoryCycle(service);
	assert.equal(secondCycle.retriedFindingIssues, 1);
	assert.equal(store.getFindingIssue({ repositoryId: "acme/app", findingId: "auth-null-bypass" }).status, "published");
	assert.equal(store.getFindingIssue({ repositoryId: "acme/app", findingId: "auth-null-bypass" }).issueNumber, 42);
	assert.equal(submissions.length, 1);
	store.close();
});

test("a GitHub adapter without Issues capability records a clear configuration failure", async () => {
	const store = preparedStore();
	const github = {
		async createCommitStatus() {
			return { id: 7 };
		},
	};

	const result = await coordinatorReturning(actionableReview()).process(cycleInput(store, github));

	assert.equal(
		result.findingIssues[0].lastError,
		"GitHub Review finding issue publication failed: github.createIssue is not a function",
	);
	store.close();
});

test("a cycle reconciles an issue created before its local mapping was recorded", async () => {
	const directory = mkdtempSync(join(tmpdir(), "big-brother-finding-reconcile-"));
	const filePath = join(directory, "state.sqlite");
	try {
		const firstStore = preparedStore(filePath);
		firstStore.setReviewJobStatus({ repositoryId: "acme/app", commitSha: "commit-3", status: "completed" });
		firstStore.stageFindingIssue({
			repositoryId: "acme/app",
			findingId: "auth-null-bypass",
			commitSha: "commit-3",
			title: "Null authorization bypass",
			body: "<!-- big-brother-finding-id: auth-null-bypass -->",
			labels: ["big-brother", "security"],
		});
		firstStore.close();

		const reopenedStore = new SqliteJobStore(filePath);
		let creations = 0;
		const github = {
			async findIssueByFindingId() {
				return { number: 42, html_url: "https://github.com/acme/app/issues/42" };
			},
			async createIssue() {
				creations += 1;
			},
		};
		const cycle = await runRepositoryCycle(repositoryService({ store: reopenedStore, github, submissions: [] }));

		assert.equal(cycle.retriedFindingIssues, 1);
		assert.equal(creations, 0);
		assert.equal(reopenedStore.getFindingIssue({ repositoryId: "acme/app", findingId: "auth-null-bypass" }).issueNumber, 42);
		reopenedStore.close();
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
});

test("clean, rejected, and non-actionable Prime results create no finding issue", async () => {
	for (const reviewResult of [
		actionableReview({ conclusion: "clean", findings: [], evidence: [], finding_issue_intents: [] }),
		actionableReview({
			findings: [],
			candidate_facts: [{ id: "worker-claim", evidence_refs: ["E1"] }],
			finding_issue_intents: [],
		}),
		actionableReview({ finding_issue_intents: [] }),
	]) {
		const store = preparedStore();
		let issues = 0;
		const github = {
			async createCommitStatus() {
				return { id: 7 };
			},
			async createIssue() {
				issues += 1;
			},
		};

		const result = await coordinatorReturning(reviewResult).process(cycleInput(store, github));
		assert.equal(issues, 0);
		assert.deepEqual(result.findingIssues, []);
		store.close();
	}
});

function preparedStore(filePath = ":memory:") {
	const store = new SqliteJobStore(filePath);
	store.enrollBranch({ repositoryId: "acme/app", branchName: "main", headSha: "commit-2" });
	store.admitCommitReview({ repositoryId: "acme/app", commitSha: "commit-3", branchName: "main" });
	return store;
}

function coordinatorReturning(reviewResult, submissions = []) {
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
			async submitReview() {
				submissions.push(reviewResult.commit_sha);
				return structuredClone(reviewResult);
			},
		},
		evidenceProvider: async () => ({
			parentSha: reviewResult.parent_sha,
			commit: { message: "fix: guard null roles" },
			changedPaths: ["src/auth.mjs"],
			diff: "diff",
			policySnapshot: {},
		}),
	});
}

function repositoryService({ store, github, submissions }) {
	return {
		profile: {
			repositoryId: "acme/app",
			cloneUrl: "https://github.com/acme/app.git",
			trackedBranches: ["main"],
			stateNamespace: "/state/acme-app",
			reviewFindingIssueLabels: ["big-brother", "security"],
		},
		store,
		readGithub: {
			async getBranchHead() {
				return { sha: "commit-3" };
			},
			async listCommits() {
				return [{ sha: "commit-3" }];
			},
		},
		publishGithub: github,
		coordinator: coordinatorReturning(actionableReview(), submissions),
	};
}

function cycleInput(store, github) {
	return {
		repositoryProfile: {
			repositoryId: "acme/app",
			cloneUrl: "https://github.com/acme/app.git",
			stateNamespace: "/state/acme-app",
			reviewFindingIssueLabels: ["big-brother", "security"],
		},
		job: { repositoryId: "acme/app", commitSha: "commit-3", observedBranches: ["main"] },
		github,
		store,
	};
}

function actionableReview(overrides = {}) {
	return {
		repository_id: "acme/app",
		commit_sha: "commit-3",
		parent_sha: "commit-2",
		observed_branches: ["main"],
		conclusion: "findings",
		message_check: { status: "pass" },
		findings: [
			{
				id: "auth-null-bypass",
				title: "Null authorization bypass",
				message: "A null role bypasses the authorization guard.",
				evidence_refs: ["E1"],
			},
		],
		policy_checks: [],
		evidence: [
			{
				id: "E1",
				commit_sha: "commit-3",
				path: "src/auth.mjs",
				line: 18,
				description: "The null branch returns before authorization is checked.",
			},
		],
		limitations: ["Static review did not execute the authorization suite."],
		candidate_facts: [],
		context_decisions: [],
		finding_issue_intents: [{ finding_id: "auth-null-bypass" }],
		...overrides,
	};
}
