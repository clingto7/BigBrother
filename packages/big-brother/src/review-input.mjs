const REVIEW_INPUT_VERSION = "1";

/**
 * Assemble the host-owned input passed to Prime for one immutable commit.
 * This is intentionally a data-only module: it does not read files, call
 * GitHub, or interpret repository instructions.
 */
export function buildReviewInput({
	repositoryId,
	commitSha,
	parentSha,
	observedBranches = [],
	commit,
	changedPaths = [],
	diff = "",
	policySnapshot,
	canonicalContext = [],
	workspace,
}) {
	assertNonEmpty(repositoryId, "repositoryId");
	assertNonEmpty(commitSha, "commitSha");
	assertNonEmpty(parentSha, "parentSha");
	if (!Array.isArray(observedBranches)) throw new Error("observedBranches must be an array");
	if (!Array.isArray(changedPaths)) throw new Error("changedPaths must be an array");
	if (typeof diff !== "string") throw new Error("diff must be a string");
	if (!Array.isArray(canonicalContext)) throw new Error("canonicalContext must be an array");
	if (workspace !== undefined && typeof workspace !== "object") throw new Error("workspace must be an object");

	const normalizedCommit = normalizeCommit({ commit, commitSha, parentSha });
	return {
		protocol_version: REVIEW_INPUT_VERSION,
		repository_id: repositoryId,
		commit_sha: commitSha,
		parent_sha: parentSha,
		observed_branches: [...new Set(observedBranches)],
		commit: normalizedCommit,
		change: {
			changed_paths: [...changedPaths],
			unified_diff: diff,
		},
		policy_snapshot: policySnapshot ?? null,
		canonical_context: canonicalContext,
		workspace: workspace
			? {
				directory: workspace.directory,
				commit_sha: workspace.commitSha ?? commitSha,
				read_only: true,
			}
			: null,
			constraints: {
				read_only: true,
				execute_project_code: false,
				install_dependencies: false,
				mutate_repository: false,
			},
	};
}

function normalizeCommit({ commit, commitSha, parentSha }) {
	if (commit === undefined) return { sha: commitSha, parent_sha: parentSha, message: "" };
	if (!commit || typeof commit !== "object") throw new Error("commit must be an object");
	if (commit.sha !== undefined && commit.sha !== commitSha) {
		throw new Error(`commit SHA mismatch: expected ${commitSha}, got ${commit.sha}`);
	}
	if (commit.parent_sha !== undefined && commit.parent_sha !== parentSha) {
		throw new Error(`commit parent SHA mismatch: expected ${parentSha}, got ${commit.parent_sha}`);
	}
	return {
		...commit,
		sha: commitSha,
		parent_sha: parentSha,
		message: typeof commit.message === "string" ? commit.message : "",
	};
}

function assertNonEmpty(value, name) {
	if (typeof value !== "string" || value.length === 0) throw new Error(`${name} must be a non-empty string`);
}
