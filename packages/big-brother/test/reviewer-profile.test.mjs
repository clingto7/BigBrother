import test from "node:test";
import assert from "node:assert/strict";

import { createReviewerProfile, loadReviewerResources } from "../src/index.mjs";

test("reviewer profile owns its prompt and skill resources", async () => {
	const profile = createReviewerProfile();

	assert.equal(profile.name, "big-brother-static-reviewer");
	assert.equal(profile.execution, "static-read-only");
	assert.equal(profile.allowRlm, false);
	assert.ok(profile.systemPromptPath.endsWith("resources/system-prompt.md"));
	assert.deepEqual(profile.runtimeArgs, [
		"--no-context-files",
		"--no-extensions",
		"--no-prompt-templates",
		"--no-themes",
		"--no-tools",
	]);

	const resources = await loadReviewerResources(profile);
	assert.match(resources.systemPrompt, /long-lived repository review coordinator/);
	assert.match(resources.systemPrompt, /immutable GitHub commit/);
	assert.equal(resources.skillPaths[0], profile.skillPaths[0]);
});

test("reviewer profile rejects unimplemented execution profiles", () => {
	assert.throws(() => createReviewerProfile({ execution: "rlm" }), /unsupported reviewer execution profile/);
});
