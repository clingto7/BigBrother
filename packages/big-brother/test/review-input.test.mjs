import test from "node:test";
import assert from "node:assert/strict";

import { buildReviewInput } from "../src/index.mjs";

test("review input assembles immutable commit evidence and static constraints", () => {
	const input = buildReviewInput({
		repositoryId: "acme/app",
		commitSha: "commit-2",
		parentSha: "commit-1",
		observedBranches: ["main", "release", "main"],
		commit: { sha: "commit-2", parent_sha: "commit-1", message: "feat: add review" },
		changedPaths: ["src/review.js"],
		diff: "diff --git a/src/review.js b/src/review.js",
		policySnapshot: { source_sha: "commit-1", documents: [{ path: "AGENTS.md" }] },
		canonicalContext: [{ fact: "reviews are advisory", source_sha: "commit-1" }],
		workspace: { directory: "/state/workspaces/commit-2", commitSha: "commit-2" },
	});

	assert.deepEqual(input.observed_branches, ["main", "release"]);
	assert.equal(input.commit.sha, "commit-2");
	assert.equal(input.commit.parent_sha, "commit-1");
	assert.equal(input.change.unified_diff.includes("review.js"), true);
	assert.equal(input.workspace.read_only, true);
	assert.deepEqual(input.constraints, {
		read_only: true,
		execute_project_code: false,
		install_dependencies: false,
		mutate_repository: false,
	});
});

test("review input rejects a moving or mismatched commit", () => {
	assert.throws(
		() => buildReviewInput({ repositoryId: "acme/app", commitSha: "commit-2", parentSha: "commit-1", commit: { sha: "head" } }),
		/commit SHA mismatch/,
	);
	assert.throws(
		() => buildReviewInput({ repositoryId: "acme/app", commitSha: "commit-2", parentSha: "commit-1", diff: null }),
		/diff must be a string/,
	);
});
