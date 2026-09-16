import test from "node:test";
import assert from "node:assert/strict";

import { loadConfiguration, validateConfiguration } from "../src/index.mjs";

const repository = {
	repositoryId: "acme/app",
	cloneUrl: "git@github.com:acme/app.git",
	trackedBranches: ["main", "release", "main"],
	stateNamespace: "/var/lib/big-brother/acme-app",
	credentials: {
		githubReadTokenEnv: "GITHUB_TOKEN",
		githubCheckRunTokenEnv: "GITHUB_CHECKS_TOKEN",
		gitSshKeyPathEnv: "GITHUB_SSH_KEY_PATH",
	},
};

test("configuration owns repository watch settings while preserving credential references", () => {
	const configuration = loadConfiguration({ pollIntervalMs: 5_000, repositories: [repository] });

	assert.equal(configuration.pollIntervalMs, 5_000);
	assert.deepEqual(configuration.repositories[0].trackedBranches, ["main", "release"]);
	assert.deepEqual(configuration.repositories[0].credentials, repository.credentials);
	assert.equal(configuration.repositories[0].githubReadToken, undefined);
});

test("configuration applies a polling default and rejects secret values", () => {
	assert.equal(loadConfiguration({ repositories: [repository] }).pollIntervalMs, 60_000);

	const invalid = { repositories: [{ ...repository, credentials: { githubReadToken: "token-value" } }] };
	assert.throws(() => loadConfiguration(invalid), /secret value/);
	const diagnostics = validateConfiguration(invalid);
	assert.equal(diagnostics.ok, false);
	assert.match(diagnostics.errors.join("; "), /not a secret value/);
});

test("configuration rejects Prime provider and model settings", () => {
	for (const field of ["provider", "model"]) {
		const invalid = { repositories: [{ ...repository, [field]: "configured-here" }] };
		assert.throws(() => loadConfiguration(invalid), new RegExp(`${field} is Prime-owned`));
	}
});

test("configuration rejects duplicate repositories and empty branch sets", () => {
	const diagnostics = validateConfiguration({
		repositories: [repository, { ...repository, trackedBranches: [] }],
	});
	assert.equal(diagnostics.ok, false);
	assert.match(diagnostics.errors.join("; "), /duplicated/);
	assert.match(diagnostics.errors.join("; "), /trackedBranches/);
});
