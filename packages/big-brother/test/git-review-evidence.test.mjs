import test from "node:test";
import assert from "node:assert/strict";

import { GitReviewEvidenceAdapter, GitCliAdapter } from "../src/index.mjs";

test("Git review evidence uses the parent policy when the commit changes policy", async () => {
	const calls = [];
	const git = {
		async readCommitReviewData(input) {
			calls.push(["commit", input]);
			return {
				parentSha: "parent-1",
				message: "feat: update policy",
				changedPaths: ["AGENTS.md", "src/app.js"],
				diff: "policy diff",
			};
		},
		async listFilesAtCommit({ commitSha }) {
			calls.push(["list", commitSha]);
			return ["AGENTS.md", "src/app.js", "docs/adr/0001-rule.md"];
		},
		async readFileAtCommit({ commitSha, path }) {
			calls.push(["read", commitSha, path]);
			return `${commitSha}:${path}`;
		},
	};

	const evidence = await new GitReviewEvidenceAdapter({ git }).collect({ directory: "/work/app", commitSha: "commit-2" });

	assert.equal(evidence.parentSha, "parent-1");
	assert.deepEqual(evidence.policySnapshot, {
		source_sha: "parent-1",
		documents: [
			{ path: "AGENTS.md", content: "parent-1:AGENTS.md" },
			{ path: "docs/adr/0001-rule.md", content: "parent-1:docs/adr/0001-rule.md" },
		],
	});
	assert.deepEqual(calls[0], ["commit", { directory: "/work/app", commitSha: "commit-2" }]);
});

test("Git CLI review evidence commands use argument arrays", async () => {
	const calls = [];
	const git = new GitCliAdapter({
		execFile: async (...args) => {
			calls.push(args);
			const command = args[1];
			if (command.includes("rev-list")) return { stdout: "commit-2 parent-1\n" };
			if (command.includes("--format=%B")) return { stdout: "feat: review\n" };
			if (command.includes("--name-only")) return { stdout: "src/app.js\n" };
			if (command.includes("--unified=80")) return { stdout: "diff --git ...\n" };
			if (command.includes("ls-tree")) return { stdout: "AGENTS.md\n" };
			return { stdout: "policy\n" };
		},
	});

	const data = await git.readCommitReviewData({ directory: "/work/app", commitSha: "commit-2" });
	assert.deepEqual(data, {
		parentSha: "parent-1",
		message: "feat: review\n",
		changedPaths: ["src/app.js"],
		diff: "diff --git ...\n",
	});
	await git.listFilesAtCommit({ directory: "/work/app", commitSha: "commit-2" });
	await git.readFileAtCommit({ directory: "/work/app", commitSha: "commit-2", path: "AGENTS.md" });
	assert.equal(calls.every(([binary, args]) => binary === "git" && Array.isArray(args)), true);
});
