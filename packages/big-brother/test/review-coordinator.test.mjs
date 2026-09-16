import test from "node:test";
import assert from "node:assert/strict";

import { ReviewCoordinator } from "../src/index.mjs";

test("review coordinator materializes, submits, and publishes one job", async () => {
	const events = [];
	const workspace = { directory: "/work/commit-3", commitSha: "commit-3" };
	const runtimeHandle = { repositoryId: "acme/app" };
	const coordinator = new ReviewCoordinator({
		workspaceManager: {
			async materialize(input) {
				events.push(["materialize", input]);
				return workspace;
			},
		},
		 runtimeSupervisor: {
			async start(profile, stateNamespace) {
				events.push(["start", profile.repositoryId, stateNamespace, profile.cwd]);
				return runtimeHandle;
			},
			async submitWorkerReview(handle, input) {
				events.push(["submit-worker", handle, input]);
				return {
					repository_id: input.repository_id,
					commit_sha: input.commit_sha,
					parent_sha: input.parent_sha,
					observed_branches: input.observed_branches,
					conclusion: "clean",
					message_check: { status: "pass" },
					findings: [],
					policy_checks: [],
					evidence: [],
					limitations: [],
					candidate_facts: [],
					context_decisions: [],
					finding_issue_intents: [],
				};
			},
			async reconcileReview(handle, input) {
				events.push(["reconcile", handle, input]);
				return {
					repository_id: input.reviewInput.repository_id,
					commit_sha: input.reviewInput.commit_sha,
					parent_sha: input.reviewInput.parent_sha,
					observed_branches: input.reviewInput.observed_branches,
					conclusion: "clean",
					message_check: { status: "pass" },
					findings: [],
					policy_checks: [],
					evidence: [],
					limitations: [],
					candidate_facts: [],
					context_decisions: [],
					finding_issue_intents: [],
				};
			},
		},
		evidenceProvider: async ({ job, workspace: materialized }) => {
			events.push(["evidence", job.commitSha, materialized.directory]);
			return {
				parentSha: "commit-2",
				commit: { message: "feat: review" },
				changedPaths: ["src/review.js"],
				diff: "diff",
				policySnapshot: { source_sha: "commit-2" },
			};
		},
		publisher: async ({ reviewResult }) => {
			events.push(["publish", reviewResult.commit_sha]);
			return { id: 7 };
		},
	});

	const result = await coordinator.process({
		repositoryProfile: {
			repositoryId: "acme/app",
			cloneUrl: "https://github.com/acme/app.git",
			stateNamespace: "/state/acme-app",
		},
		job: { repositoryId: "acme/app", commitSha: "commit-3", observedBranches: ["main"] },
		github: {},
		store: {},
	});

	assert.deepEqual(events.map(([operation]) => operation), ["materialize", "evidence", "start", "submit-worker", "reconcile", "publish"]);
	assert.deepEqual(events.find(([operation]) => operation === "start"), ["start", "acme/app", "/state/acme-app", "/work/commit-3"]);
	assert.equal(result.reviewInput.workspace.read_only, true);
	assert.equal(result.reviewInput.commit.parent_sha, "commit-2");
	assert.deepEqual(result.published, { id: 7 });
});

test("review coordinator retries reconciliation in a fresh Prime session after a stale fact decision", async () => {
	const events = [];
	const workerResult = {
		repository_id: "acme/app",
		commit_sha: "commit-3",
		parent_sha: "commit-2",
		observed_branches: ["main"],
		conclusion: "findings",
		message_check: { status: "pass" },
		findings: [{ id: "finding-1", evidence_refs: ["E1"] }],
		policy_checks: [],
		evidence: [{ id: "E1", path: "src/app.ts", line: 1 }],
		limitations: [],
		candidate_facts: [],
	};
	const staleResult = {
		...workerResult,
		context_decisions: [{
			id: "decision-1",
			action: "correct",
			fact_id: "stale-fact",
			statement: "A stale fact.",
			evidence_refs: ["E1"],
			rationale: "Prime reconciled old session context.",
		}],
		finding_issue_intents: [{ finding_id: "finding-1" }],
	};
	const validResult = {
		...workerResult,
		context_decisions: [],
		finding_issue_intents: [{ finding_id: "finding-1" }],
	};
	const reconciliations = [staleResult, validResult];
	const runtimeHandle = { repositoryId: "acme/app" };
	const coordinator = new ReviewCoordinator({
		workspaceManager: {
			async materialize() { return { directory: "/work/commit-3", commitSha: "commit-3" }; },
		},
		runtimeSupervisor: {
			async start() { return runtimeHandle; },
			async submitWorkerReview() { return workerResult; },
			async reconcileReview(_handle, input) {
				events.push(["reconcile", input.recoveryNotice, input.mappedFindingIssues]);
				return reconciliations.shift();
			},
			async startFreshSession() { events.push(["new-session"]); },
		},
		evidenceProvider: async () => ({
			parentSha: "commit-2",
			commit: { message: "fix: protect operation errors" },
			changedPaths: ["src/app.ts"],
			diff: "diff",
			policySnapshot: {},
		}),
		publisher: async () => {
			events.push(["publish"]);
			return { id: 7 };
		},
		findingIssuePublisher: async () => [],
	});
	const store = {
		getContextLedger: () => [],
		listFindingIssueStates: () => [{
			findingId: "finding-1",
			issueNumber: 42,
			issueUrl: "https://github.com/acme/app/issues/42",
			lifecycleStatus: "active",
			title: "Existing finding",
			body: "Existing evidence",
			labels: ["big-brother"],
		}],
		validateContextDecisions({ reviewResult }) {
			if (reviewResult.context_decisions.length > 0) throw new Error("cannot correct unknown fact: stale-fact");
		},
		recordReviewResult() {},
	};

	const result = await coordinator.process({
		repositoryProfile: { repositoryId: "acme/app", cloneUrl: "https://github.com/acme/app.git", stateNamespace: "/state/acme-app" },
		job: { repositoryId: "acme/app", commitSha: "commit-3", observedBranches: ["main"] },
		github: {},
		store,
	});

	assert.deepEqual(events.map(([operation]) => operation), ["reconcile", "new-session", "reconcile", "publish"]);
	assert.match(events[2][1], /unknown fact/);
	assert.equal(events[0][2][0].findingId, "finding-1");
	assert.deepEqual(result.reviewResult, validResult);
});

test("review coordinator refuses a job from another repository", async () => {
	const coordinator = new ReviewCoordinator({
		workspaceManager: { async materialize() {} },
		runtimeSupervisor: {},
		evidenceProvider: async () => ({}),
	});

	await assert.rejects(
		coordinator.process({
			repositoryProfile: { repositoryId: "acme/app" },
			job: { repositoryId: "other/app", commitSha: "commit-3" },
		}),
		/repository.*do not match/,
	);
});
