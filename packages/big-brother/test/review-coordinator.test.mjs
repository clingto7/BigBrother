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
			async submitReview(handle, input) {
				events.push(["submit", handle, input]);
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

	assert.deepEqual(events.map(([operation]) => operation), ["materialize", "evidence", "start", "submit", "publish"]);
	assert.deepEqual(events.find(([operation]) => operation === "start"), ["start", "acme/app", "/state/acme-app", "/work/commit-3"]);
	assert.equal(result.reviewInput.workspace.read_only, true);
	assert.equal(result.reviewInput.commit.parent_sha, "commit-2");
	assert.deepEqual(result.published, { id: 7 });
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
