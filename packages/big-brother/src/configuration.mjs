import { readFile } from "node:fs/promises";

const DEFAULT_POLL_INTERVAL_MS = 60_000;
const ENV_NAME = /^[A-Z][A-Z0-9_]*$/;
const REPOSITORY_ID = /^[^/\s]+\/[^/\s]+$/;

/** Load and normalize Big Brother's control-plane configuration. */
export function loadConfiguration(source) {
	let value = source;
	if (typeof source === "string") {
		try {
			value = JSON.parse(source);
		} catch (error) {
			throw new Error(`invalid Big Brother configuration JSON: ${error.message}`);
		}
	}

	const diagnostics = validateConfiguration(value);
	if (!diagnostics.ok) {
		throw new Error(`invalid Big Brother configuration: ${diagnostics.errors.join("; ")}`);
	}

	return normalizeConfiguration(value);
}

export async function loadConfigurationFile(filePath) {
	return loadConfiguration(await readFile(filePath, "utf8"));
}

export function validateConfiguration(configuration) {
	const errors = [];
	if (!configuration || typeof configuration !== "object" || Array.isArray(configuration)) {
		return { ok: false, errors: ["configuration must be an object"] };
	}

	if (configuration.pollIntervalMs !== undefined && (!Number.isInteger(configuration.pollIntervalMs) || configuration.pollIntervalMs < 1_000)) {
		errors.push("pollIntervalMs must be an integer greater than or equal to 1000");
	}
	if (!Array.isArray(configuration.repositories) || configuration.repositories.length === 0) {
		errors.push("repositories must be a non-empty array");
		return { ok: false, errors };
	}

	const repositoryIds = new Set();
	for (const [index, repository] of configuration.repositories.entries()) {
		const prefix = `repositories[${index}]`;
		if (!repository || typeof repository !== "object" || Array.isArray(repository)) {
			errors.push(`${prefix} must be an object`);
			continue;
		}
		if (typeof repository.repositoryId !== "string" || !REPOSITORY_ID.test(repository.repositoryId)) {
			errors.push(`${prefix}.repositoryId must use the owner/name form`);
		} else if (repositoryIds.has(repository.repositoryId)) {
			errors.push(`${prefix}.repositoryId is duplicated: ${repository.repositoryId}`);
		} else {
			repositoryIds.add(repository.repositoryId);
		}
		if (typeof repository.cloneUrl !== "string" || repository.cloneUrl.length === 0) {
			errors.push(`${prefix}.cloneUrl must be a non-empty string`);
		}
		if (!Array.isArray(repository.trackedBranches) || repository.trackedBranches.length === 0) {
			errors.push(`${prefix}.trackedBranches must be a non-empty array`);
		} else if (repository.trackedBranches.some((branch) => typeof branch !== "string" || branch.length === 0)) {
			errors.push(`${prefix}.trackedBranches must contain non-empty strings`);
		}
		if (typeof repository.stateNamespace !== "string" || repository.stateNamespace.length === 0) {
			errors.push(`${prefix}.stateNamespace must be a non-empty string`);
		}
		if (
			repository.reviewFindingIssueLabels !== undefined &&
			(!Array.isArray(repository.reviewFindingIssueLabels) ||
				repository.reviewFindingIssueLabels.some((label) => typeof label !== "string" || label.length === 0))
		) {
			errors.push(`${prefix}.reviewFindingIssueLabels must contain non-empty strings`);
		}
		validateCredentialRefs(repository, prefix, errors);
		for (const field of ["provider", "model"]) {
			if (repository[field] !== undefined) errors.push(`${prefix}.${field} is Prime-owned; configure it with 'big-brother agent'`);
		}
	}

	return { ok: errors.length === 0, errors };
}

function normalizeConfiguration(configuration) {
	return {
		pollIntervalMs: configuration.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS,
		repositories: configuration.repositories.map((repository) => ({
			repositoryId: repository.repositoryId,
			cloneUrl: repository.cloneUrl,
			trackedBranches: [...new Set(repository.trackedBranches)],
			stateNamespace: repository.stateNamespace,
			reviewFindingIssueLabels: [...new Set(repository.reviewFindingIssueLabels ?? [])],
			credentials: repository.credentials ? { ...repository.credentials } : {},
		})),
	};
}

function validateCredentialRefs(repository, prefix, errors) {
	const credentials = repository.credentials;
	if (credentials === undefined) return;
	if (!credentials || typeof credentials !== "object" || Array.isArray(credentials)) {
		errors.push(`${prefix}.credentials must be an object`);
		return;
	}
	for (const field of ["githubReadTokenEnv", "githubStatusTokenEnv", "githubCheckRunTokenEnv", "gitSshKeyPathEnv"]) {
		const value = credentials[field];
		if (value !== undefined && (typeof value !== "string" || !ENV_NAME.test(value))) {
			errors.push(`${prefix}.credentials.${field} must be an uppercase environment variable name`);
		}
	}
	for (const field of ["githubReadToken", "githubCheckRunToken", "gitSshKey"]) {
		if (credentials[field] !== undefined) errors.push(`${prefix}.credentials.${field} must be an environment-variable reference, not a secret value`);
	}
}
