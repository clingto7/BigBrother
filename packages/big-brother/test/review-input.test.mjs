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
	assert.equal("workspace" in input, false);
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

test("review input preserves optional external review provenance as advisory Focus hints", () => {
	const input = buildReviewInput({
		repositoryId: "acme/app", commitSha: "commit-2", parentSha: "commit-1",
		externalReviewEvidence: {
			status: "available", engine: { name: "ocr" }, source_range: { base: "commit-1", head: "commit-2" },
			comments: [{ path: "src/auth.mjs", line: 8 }], warnings: [], provenance: { workflow: "review.yml" },
		},
	});
	assert.deepEqual(input.external_review_evidence.focus_hints, [{ path: "src/auth.mjs", line: 8 }]);
	assert.deepEqual(input.external_review_evidence.source_range, { base: "commit-1", head: "commit-2" });
	const unavailable = buildReviewInput({ repositoryId: "acme/app", commitSha: "commit-2", parentSha: "commit-1", externalReviewEvidence: { comments: null } });
	assert.equal(unavailable.external_review_evidence.status, "unavailable");
	assert.match(unavailable.external_review_evidence.warnings[0], /comments: null/);
});
