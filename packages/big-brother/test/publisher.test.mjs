import test from "node:test";
import assert from "node:assert/strict";

import { publishReviewResult } from "../src/index.mjs";
import { InMemoryJobStore } from "../src/index.mjs";

function review(overrides = {}) {
  return {
    repository_id: "acme/app",
    commit_sha: "commit-3",
    parent_sha: "commit-2",
    observed_branches: ["main"],
    conclusion: "clean",
    message_check: { status: "pass" },
    findings: [],
    policy_checks: [],
    evidence: [],
    limitations: [],
    candidate_facts: [],
    ...overrides,
  };
}

test("publisher creates a successful Check Run for a clean review", async () => {
  let request;
  const github = {
    async createCheckRun(input) {
      request = input;
      return { id: 42 };
    },
  };

  const result = await publishReviewResult({ github, reviewResult: review() });

  assert.deepEqual(result, { id: 42 });
  assert.deepEqual(request, {
    repositoryId: "acme/app",
    name: "Big Brother",
    headSha: "commit-3",
    conclusion: "success",
    output: {
      title: "Big Brother review: clean",
      summary: "No findings. Message and policy checks passed.",
      text: "Reviewed commit `commit-3` on main.",
    },
  });
});

test("publisher prefers an advisory Commit Status when the adapter supports it", async () => {
  let request;
  const github = {
    async createCommitStatus(input) {
      request = input;
      return { id: 7, state: "success" };
    },
    async createCheckRun() {
      throw new Error("publisher should not use Check Runs when Commit Status is available");
    },
  };

  const result = await publishReviewResult({ github, reviewResult: review() });

  assert.deepEqual(result, { id: 7, state: "success" });
  assert.deepEqual(request, {
    repositoryId: "acme/app",
    commitSha: "commit-3",
    state: "success",
    context: "big-brother/review",
    description: "Big Brother: clean",
  });
});

test("publisher updates an existing Check Run neutrally when findings exist", async () => {
  let request;
  const github = {
    async updateCheckRun(input) {
      request = input;
      return { id: 42, conclusion: "neutral" };
    },
  };

  const result = await publishReviewResult({
    github,
    checkRunId: 42,
    reviewResult: review({
      conclusion: "findings",
      findings: [{ id: "finding-1", title: "Missing guard", evidence_refs: ["evidence-1"] }],
      evidence: [{ id: "evidence-1", path: "src/app.ts", line: 12 }],
    }),
  });

  assert.deepEqual(result, { id: 42, conclusion: "neutral" });
  assert.deepEqual(request, {
    repositoryId: "acme/app",
    checkRunId: 42,
    conclusion: "neutral",
    output: {
      title: "Big Brother review: findings",
      summary: "1 finding requires attention.",
      text: "Reviewed commit `commit-3` on main.\n\n- Missing guard (src/app.ts:12)",
    },
  });
});

test("publisher rejects an invalid review before calling GitHub", async () => {
  let called = false;
  const github = {
    async createCheckRun() {
      called = true;
    },
  };

  await assert.rejects(
    publishReviewResult({ github, reviewResult: review({ findings: [{ id: "finding-1", evidence_refs: [] }] }) }),
    /invalid review result.*evidence/i,
  );
  assert.equal(called, false);
});

test("publisher persists and reuses the Check Run ID", async () => {
  const store = new InMemoryJobStore();
  store.enrollBranch({ repositoryId: "acme/app", branchName: "main", headSha: "commit-2" });
  store.admitCommitReview({ repositoryId: "acme/app", commitSha: "commit-3", branchName: "main" });
  const calls = [];
  const github = {
    async createCheckRun(input) {
      calls.push(["create", input]);
      return { id: 42 };
    },
    async updateCheckRun(input) {
      calls.push(["update", input]);
      return { id: 42 };
    },
  };

  await publishReviewResult({ github, store, reviewResult: review() });
  await publishReviewResult({ github, store, reviewResult: review({ conclusion: "findings" }) });

  assert.deepEqual(calls.map(([operation]) => operation), ["create", "update"]);
  assert.equal(store.getReviewJob({ repositoryId: "acme/app", commitSha: "commit-3" }).checkRunId, 42);
});
