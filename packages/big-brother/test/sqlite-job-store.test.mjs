import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

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
