import test from "node:test";
import assert from "node:assert/strict";

import {
  InMemoryJobStore,
  pollRepository,
  selectPolicySnapshot,
  assertReviewResultIdentity,
  validateWorkerReviewResult,
  validateReviewResult,
} from "../src/index.mjs";

test("a commit discovered on two tracked branches becomes one job with both associations", () => {
  const store = new InMemoryJobStore();

  store.enrollBranch({ repositoryId: "acme/app", branchName: "main", headSha: "main-1" });
  store.enrollBranch({ repositoryId: "acme/app", branchName: "release", headSha: "release-1" });

  assert.equal(
    store.admitCommitReview({ repositoryId: "acme/app", commitSha: "commit-2", branchName: "main" }).created,
    true,
  );
  assert.equal(
    store.admitCommitReview({ repositoryId: "acme/app", commitSha: "commit-2", branchName: "release" }).created,
    false,
  );
  assert.deepEqual(store.getReviewJob({ repositoryId: "acme/app", commitSha: "commit-2" }).observedBranches, [
    "main",
    "release",
  ]);
});

test("enrolling a branch establishes its current tip as the baseline", () => {
  const store = new InMemoryJobStore();

  const enrollment = store.enrollBranch({ repositoryId: "acme/app", branchName: "feature", headSha: "commit-9" });

  assert.deepEqual(enrollment, { created: true, baselineSha: "commit-9" });
  assert.equal(store.listReviewJobs("acme/app").length, 0);
});

test("in-memory job store persists review status transitions", () => {
  const store = new InMemoryJobStore();
  store.enrollBranch({ repositoryId: "acme/app", branchName: "main", headSha: "commit-1" });
  store.admitCommitReview({ repositoryId: "acme/app", commitSha: "commit-2", branchName: "main" });
  store.setReviewJobStatus({ repositoryId: "acme/app", commitSha: "commit-2", status: "failed" });
  assert.equal(store.getReviewJob({ repositoryId: "acme/app", commitSha: "commit-2" }).status, "failed");
});

test("polling enqueues every commit after the cursor and advances the cursor", async () => {
  const store = new InMemoryJobStore();
  store.enrollBranch({ repositoryId: "acme/app", branchName: "main", headSha: "commit-1" });

  const github = {
    async getBranchHead({ repositoryId, branchName }) {
      assert.deepEqual({ repositoryId, branchName }, { repositoryId: "acme/app", branchName: "main" });
      return { sha: "commit-3" };
    },
    async listCommits({ repositoryId, branchName, fromSha, toSha }) {
      assert.deepEqual(
        { repositoryId, branchName, fromSha, toSha },
        { repositoryId: "acme/app", branchName: "main", fromSha: "commit-1", toSha: "commit-3" },
      );
      return [{ sha: "commit-2" }, { sha: "commit-3" }];
    },
  };

  const result = await pollRepository({
    repositoryId: "acme/app",
    trackedBranches: ["main"],
    github,
    store,
  });

  assert.deepEqual(result, { branches: 1, discovered: 2 });
  assert.deepEqual(
    store.listReviewJobs("acme/app").map((job) => job.commitSha),
    ["commit-2", "commit-3"],
  );
  assert.equal(store.getBranch({ repositoryId: "acme/app", branchName: "main" }).cursorSha, "commit-3");
});

test("an incomplete GitHub range does not advance the branch cursor", async () => {
  const store = new InMemoryJobStore();
  store.enrollBranch({ repositoryId: "acme/app", branchName: "main", headSha: "commit-1" });

  const github = {
    async getBranchHead() {
      return { sha: "commit-3" };
    },
    async listCommits() {
      return [{ sha: "commit-2" }];
    },
  };

  await assert.rejects(
    pollRepository({ repositoryId: "acme/app", trackedBranches: ["main"], github, store }),
    /did not reach branch head/,
  );
  assert.equal(store.getBranch({ repositoryId: "acme/app", branchName: "main" }).cursorSha, "commit-1");
  assert.equal(store.listReviewJobs("acme/app").length, 0);
});

test("a commit changing project policy is judged against the parent policy snapshot", () => {
  const selected = selectPolicySnapshot({
    changedPaths: ["AGENTS.md", "src/app.ts"],
    parentPolicy: { revision: "parent" },
    currentPolicy: { revision: "commit" },
  });

  assert.deepEqual(selected, { revision: "parent" });
});

test("a normal commit uses the current policy snapshot", () => {
  const selected = selectPolicySnapshot({
    changedPaths: ["src/app.ts"],
    parentPolicy: { revision: "parent" },
    currentPolicy: { revision: "commit" },
  });

  assert.deepEqual(selected, { revision: "commit" });
});

test("a review result is accepted only when every finding cites returned evidence", () => {
  const valid = validateReviewResult({
    repository_id: "acme/app",
    commit_sha: "commit-2",
    parent_sha: "commit-1",
    observed_branches: ["main"],
    conclusion: "findings",
    message_check: { status: "pass" },
    findings: [{ id: "finding-1", evidence_refs: ["evidence-1"] }],
    policy_checks: [],
    evidence: [{ id: "evidence-1", path: "src/app.ts", line: 12 }],
    limitations: [],
    candidate_facts: [],
    context_decisions: [],
    finding_issue_intents: [],
  });

  assert.deepEqual(valid, { ok: true, errors: [] });
});

test("a worker result cannot contain Prime decisions or issue intents", () => {
	const result = validateWorkerReviewResult({
		repository_id: "acme/app",
		commit_sha: "commit-2",
		parent_sha: "commit-1",
		observed_branches: ["main"],
		conclusion: "findings",
		message_check: { status: "pass" },
		findings: [{ id: "finding-1", evidence_refs: ["E1"] }],
		policy_checks: [],
		evidence: [{ id: "E1", path: "src/app.ts", line: 12 }],
		limitations: [],
		candidate_facts: [],
		context_decisions: [{ id: "decision-1" }],
		finding_issue_intents: [{ finding_id: "finding-1" }],
	});

	assert.equal(result.ok, false);
	assert.match(result.errors.join("\n"), /worker review cannot contain context decisions/);
	assert.match(result.errors.join("\n"), /worker review cannot contain finding issue intents/);
});

test("review identity is bound to the admitted repository job", () => {
	assert.throws(
		() => assertReviewResultIdentity({
			repositoryId: "acme/app",
			commitSha: "commit-2",
			reviewResult: { repository_id: "attacker/app", commit_sha: "commit-2" },
		}),
		/review result does not match review job: acme\/app:commit-2/,
	);
});

test("a finding without evidence is rejected by the review contract", () => {
  const result = validateReviewResult({
    repository_id: "acme/app",
    commit_sha: "commit-2",
    parent_sha: "commit-1",
    observed_branches: [],
    conclusion: "findings",
    message_check: { status: "pass" },
    findings: [{ id: "finding-1", evidence_refs: [] }],
    policy_checks: [],
    evidence: [],
    limitations: [],
    candidate_facts: [],
    context_decisions: [],
    finding_issue_intents: [],
  });

  assert.equal(result.ok, false);
  assert.match(result.errors[0], /evidence/i);
});

test("a context decision is accepted only when it cites returned evidence", () => {
  const result = validateReviewResult({
    repository_id: "acme/app",
    commit_sha: "commit-2",
    parent_sha: "commit-1",
    observed_branches: ["main"],
    conclusion: "clean",
    message_check: { status: "pass" },
    findings: [],
    policy_checks: [],
    evidence: [],
    limitations: [],
    candidate_facts: [],
    context_decisions: [
      {
        id: "decision-1",
        action: "admit",
        fact_id: "fact-1",
        statement: "The repository uses ESM.",
        evidence_refs: ["missing-evidence"],
        rationale: "Prime accepted the worker proposal.",
      },
    ],
    finding_issue_intents: [],
  });

  assert.equal(result.ok, false);
  assert.match(result.errors.join("\n"), /context decision decision-1 cites unknown evidence/i);
});

test("a context decision requires a rationale and cannot accompany a clean review", () => {
  const base = {
    repository_id: "acme/app",
    commit_sha: "commit-2",
    parent_sha: "commit-1",
    observed_branches: ["main"],
    conclusion: "findings",
    message_check: { status: "pass" },
    findings: [],
    policy_checks: [],
    evidence: [{ id: "E1", path: "README.md" }],
    limitations: [],
    candidate_facts: [],
    context_decisions: [
      {
        id: "decision-1",
        action: "admit",
        fact_id: "fact-1",
        statement: "The repository uses ESM.",
        evidence_refs: ["E1"],
      },
    ],
    finding_issue_intents: [],
  };

  const missingRationale = validateReviewResult(base);
  assert.equal(missingRationale.ok, false);
  assert.match(missingRationale.errors.join("\n"), /context decision decision-1 must have a non-empty rationale/i);

  const cleanAdmission = validateReviewResult({
    ...base,
    conclusion: "clean",
    context_decisions: [{ ...base.context_decisions[0], rationale: "Prime admitted cited evidence." }],
  });
  assert.equal(cleanAdmission.ok, false);
  assert.match(cleanAdmission.errors.join("\n"), /clean review cannot contain context decisions/i);
});

test("a finding issue intent must identify an evidence-backed finding in the same Prime result", () => {
	const result = validateReviewResult({
		repository_id: "acme/app",
		commit_sha: "commit-2",
		parent_sha: "commit-1",
		observed_branches: ["main"],
		conclusion: "findings",
		message_check: { status: "pass" },
		findings: [{ id: "finding-1", evidence_refs: ["E1"] }],
		policy_checks: [],
		evidence: [{ id: "E1", path: "src/app.ts", line: 12 }],
		limitations: [],
		candidate_facts: [],
		context_decisions: [],
		finding_issue_intents: [{ finding_id: "unknown-finding" }],
	});

	assert.equal(result.ok, false);
	assert.match(result.errors.join("\n"), /finding issue intent cites unknown finding: unknown-finding/i);
});

test("an explicit resolution intent may accompany a clean review", () => {
	const result = validateReviewResult({
		repository_id: "acme/app",
		commit_sha: "commit-4",
		parent_sha: "commit-3",
		observed_branches: ["main"],
		conclusion: "clean",
		message_check: { status: "pass" },
		findings: [],
		policy_checks: [],
		evidence: [],
		limitations: [],
		candidate_facts: [],
		context_decisions: [],
		finding_issue_intents: [{ finding_id: "auth-null-bypass", action: "resolve" }],
	});

	assert.deepEqual(result, { ok: true, errors: [] });
});
