import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";

import { SqliteJobStore } from "../src/index.mjs";

test("SQLite Job Store survives restart and retains branch associations", () => {
  const directory = mkdtempSync(join(tmpdir(), "big-brother-job-store-"));
  const filePath = join(directory, "state.sqlite");

  try {
    const first = new SqliteJobStore(filePath);
    first.enrollBranch({ repositoryId: "acme/app", branchName: "main", headSha: "commit-1" });
    first.enrollBranch({ repositoryId: "acme/app", branchName: "release", headSha: "commit-1" });
    first.admitCommitReview({ repositoryId: "acme/app", commitSha: "commit-2", branchName: "main" });
    first.admitCommitReview({ repositoryId: "acme/app", commitSha: "commit-2", branchName: "release" });
    first.recordCheckRun({ repositoryId: "acme/app", commitSha: "commit-2", checkRunId: 42 });
    first.advanceBranch({ repositoryId: "acme/app", branchName: "main", headSha: "commit-2" });
    first.close();

    const second = new SqliteJobStore(filePath);
    assert.equal(second.getBranch({ repositoryId: "acme/app", branchName: "main" }).cursorSha, "commit-2");
    assert.deepEqual(second.getReviewJob({ repositoryId: "acme/app", commitSha: "commit-2" }).observedBranches, [
      "main",
      "release",
    ]);
    assert.equal(second.getReviewJob({ repositoryId: "acme/app", commitSha: "commit-2" }).checkRunId, 42);
    second.close();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("SQLite Job Store persists review status transitions", () => {
  const store = new SqliteJobStore(":memory:");
  store.enrollBranch({ repositoryId: "acme/app", branchName: "main", headSha: "commit-1" });
  store.admitCommitReview({ repositoryId: "acme/app", commitSha: "commit-2", branchName: "main" });
  store.setReviewJobStatus({ repositoryId: "acme/app", commitSha: "commit-2", status: "reviewing" });
  assert.equal(store.getReviewJob({ repositoryId: "acme/app", commitSha: "commit-2" }).status, "reviewing");
  store.setReviewJobStatus({ repositoryId: "acme/app", commitSha: "commit-2", status: "completed" });
  assert.equal(store.getReviewJob({ repositoryId: "acme/app", commitSha: "commit-2" }).status, "completed");
  store.close();
});

test("SQLite Job Store migrates existing jobs and persists retry backoff", () => {
	const directory = mkdtempSync(join(tmpdir(), "big-brother-retry-"));
	const filePath = join(directory, "state.sqlite");
	try {
		const old = new DatabaseSync(filePath);
		old.exec(`CREATE TABLE review_jobs (repository_id TEXT NOT NULL, commit_sha TEXT NOT NULL, status TEXT NOT NULL, check_run_id INTEGER, review_result_json TEXT, PRIMARY KEY (repository_id, commit_sha));`);
		old.prepare(`INSERT INTO review_jobs (repository_id, commit_sha, status) VALUES (?, ?, ?)`)
			.run("acme/app", "commit-2", "failed");
		old.close();

		let store = new SqliteJobStore(filePath);
		assert.equal(store.getReviewJob({ repositoryId: "acme/app", commitSha: "commit-2" }).retryCount, 0);
		store.setReviewJobStatus({ repositoryId: "acme/app", commitSha: "commit-2", status: "failed", nextRetryAt: 301_000 });
		store.close();
		store = new SqliteJobStore(filePath);
		assert.equal(store.getReviewJob({ repositoryId: "acme/app", commitSha: "commit-2" }).retryCount, 1);
		assert.equal(store.getReviewJob({ repositoryId: "acme/app", commitSha: "commit-2" }).nextRetryAt, 301_000);
		store.setReviewJobStatus({ repositoryId: "acme/app", commitSha: "commit-2", status: "completed" });
		assert.equal(store.getReviewJob({ repositoryId: "acme/app", commitSha: "commit-2" }).retryCount, 0);
		assert.equal(store.getReviewJob({ repositoryId: "acme/app", commitSha: "commit-2" }).nextRetryAt, null);
		store.close();
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
});

test("SQLite Job Store retains distinct worker attempts across reopen", () => {
	const directory = mkdtempSync(join(tmpdir(), "big-brother-worker-attempts-"));
	const filePath = join(directory, "state.sqlite");
	try {
		let store = new SqliteJobStore(filePath);
		store.enrollBranch({ repositoryId: "acme/app", branchName: "main", headSha: "commit-2" });
		store.admitCommitReview({ repositoryId: "acme/app", commitSha: "commit-3", branchName: "main" });
		store.recordWorkerAttempt({ repositoryId: "acme/app", commitSha: "commit-3", attemptId: "attempt-1", status: "timed_out", inputDigest: "digest-1", error: "timeout" });
		store.recordWorkerAttempt({ repositoryId: "acme/app", commitSha: "commit-3", attemptId: "attempt-2", status: "success", inputDigest: "digest-1" });
		store.close();
		store = new SqliteJobStore(filePath);
		assert.deepEqual(store.listWorkerAttempts({ repositoryId: "acme/app", commitSha: "commit-3" }).map(({ attemptId, status }) => ({ attemptId, status })), [
			{ attemptId: "attempt-1", status: "timed_out" },
			{ attemptId: "attempt-2", status: "success" },
		]);
		store.close();
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
});
