import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ReviewCoordinator, SqliteJobStore, runWatch } from "../src/index.mjs";

test("background watch completes and recovers one repository review cycle after restart", async () => {
	const directory = mkdtempSync(join(tmpdir(), "big-brother-watch-integration-"));
	const statePath = join(directory, "state.sqlite");
	let headSha = "baseline";
	let allowIssuePublication = false;
	let issueCreations = 0;
	let statusPublications = 0;
	let remoteIssue;
	const submissions = [];
	const output = [];
	const errors = [];
	const reviewResult = reviewResultFor("commit-3");

	const github = {
		async getBranchHead() {
			return { sha: headSha };
		},
		async listCommits({ fromSha, toSha }) {
			assert.equal(fromSha, "baseline");
			assert.equal(toSha, "commit-3");
			return [{ sha: "commit-3" }];
		},
		async createCommitStatus(input) {
			statusPublications += 1;
			assert.equal(input.commitSha, "commit-3");
			assert.equal(input.state, "failure");
			assert.equal(input.context, "big-brother/review");
			return { id: 7 };
		},
		async createIssue(input) {
			if (!allowIssuePublication) {
				throw new Error("GitHub API request failed (403): Issues permission is missing");
			}
			issueCreations += 1;
			remoteIssue = { number: 42, html_url: "https://github.com/acme/app/issues/42", state: "open", ...input };
			return remoteIssue;
		},
		async findIssueByFindingId() {
			return remoteIssue;
		},
	};

	try {
		const firstStore = new SqliteJobStore(statePath);
		await runWatch(configuration(), { once: true }, {
			servicesFactory: () => createService(firstStore, github, submissions),
			stdout: (line) => output.push(line),
			stderr: (line) => errors.push(line),
		});

		headSha = "commit-3";
		await runWatch(configuration(), { once: true }, {
			servicesFactory: () => createService(firstStore, github, submissions),
			stdout: (line) => output.push(line),
			stderr: (line) => errors.push(line),
		});

		assert.match(output[1], /discovered=1 processed=1 failed=0/);
		assert.equal(statusPublications, 1);
		assert.equal(issueCreations, 0);
		assert.equal(submissions.length, 1);
		assert.equal(firstStore.getReviewJob({ repositoryId: "acme/app", commitSha: "commit-3" }).status, "completed");
		assert.deepEqual(firstStore.getReviewResult({ repositoryId: "acme/app", commitSha: "commit-3" }), reviewResult);
		assert.equal(firstStore.getContextLedger("acme/app")[0].status, "active");
		assert.equal(firstStore.getFindingIssue({ repositoryId: "acme/app", findingId: "auth-null-bypass" }).status, "failed");
		assert.match(errors.at(-1), /Issues permission is missing/);

		firstStore.close();
		const restartedStore = new SqliteJobStore(statePath);
		allowIssuePublication = true;
		const restartedSubmissions = [];
		const recoveryOutput = [];
		await runWatch(configuration(), { once: true }, {
			servicesFactory: () => createService(restartedStore, github, restartedSubmissions),
			stdout: (line) => recoveryOutput.push(line),
			stderr: (line) => errors.push(line),
		});

		assert.match(recoveryOutput[0], /discovered=0 processed=0 failed=0 publication-retried=1 publication-pending=0 publication-failed=0/);
		assert.equal(issueCreations, 1);
		assert.equal(statusPublications, 1);
		assert.deepEqual(restartedSubmissions, []);
		assert.equal(restartedStore.getFindingIssue({ repositoryId: "acme/app", findingId: "auth-null-bypass" }).status, "published");

		const repeatedOutput = [];
		await runWatch(configuration(), { once: true }, {
			servicesFactory: () => createService(restartedStore, github, restartedSubmissions),
			stdout: (line) => repeatedOutput.push(line),
			stderr: () => {},
		});
		assert.match(repeatedOutput[0], /discovered=0 processed=0 failed=0 publication-retried=0/);
		assert.equal(issueCreations, 1);
		assert.equal(statusPublications, 1);
		assert.deepEqual(restartedStore.getReviewResult({ repositoryId: "acme/app", commitSha: "commit-3" }), reviewResult);
		restartedStore.close();
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
});

function configuration() {
	return {
		pollIntervalMs: 1_000,
		repositories: [{
			repositoryId: "acme/app",
			cloneUrl: "https://github.com/acme/app.git",
			trackedBranches: ["main"],
			stateNamespace: "/state/acme-app",
			reviewFindingIssueLabels: ["big-brother", "security"],
		}],
	};
}

function createService(store, github, submissions) {
	return {
		profile: configuration().repositories[0],
		store,
		readGithub: github,
		publishGithub: github,
		coordinator: new ReviewCoordinator({
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
					submissions.push(structuredClone(input));
					return structuredClone(reviewResultFor(input.commit_sha));
				},
			},
			evidenceProvider: async ({ job }) => ({
				parentSha: "baseline",
				commit: { message: "fix: guard null roles" },
				changedPaths: ["src/auth.mjs"],
				diff: "diff --git a/src/auth.mjs b/src/auth.mjs",
				policySnapshot: { source: "AGENTS.md", content: "Review every commit." },
				commitSha: job.commitSha,
			}),
		}),
		close: async () => {},
	};
}

function reviewResultFor(commitSha) {
	return {
		repository_id: "acme/app",
		commit_sha: commitSha,
		parent_sha: "baseline",
		observed_branches: ["main"],
		conclusion: "findings",
		message_check: { status: "pass" },
		findings: [{
			id: "auth-null-bypass",
			title: "Null authorization bypass",
			message: "A null role bypasses the authorization guard.",
			evidence_refs: ["E1"],
		}],
		policy_checks: [],
		evidence: [{
			id: "E1",
			commit_sha: commitSha,
			path: "src/auth.mjs",
			line: 18,
			description: "The null branch returns before authorization is checked.",
		}],
		limitations: ["Static review did not execute the authorization suite."],
		candidate_facts: [{ id: "worker-policy", statement: "Reviews follow repository policy.", evidence_refs: ["E1"] }],
		context_decisions: [{
			id: "decision-1",
			action: "admit",
			fact_id: "review-policy",
			statement: "Reviews follow repository policy.",
			evidence_refs: ["E1"],
			rationale: "Prime reconciled the evidence-backed repository policy.",
		}],
		finding_issue_intents: [{ finding_id: "auth-null-bypass" }],
	};
}
