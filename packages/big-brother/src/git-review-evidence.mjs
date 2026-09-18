import { isProjectPolicyPath, selectPolicySnapshot } from "./policy-resolver.mjs";
import { GitCliAdapter } from "./workspace.mjs";

const DEFAULT_MAX_POLICY_BYTES = 512 * 1024;

/**
 * Collect static review evidence from a verified detached workspace. Every Git
 * operation is read-only and goes through the Git adapter seam.
 */
export class GitReviewEvidenceAdapter {
	#git;
	#maxPolicyBytes;

	constructor({ git = new GitCliAdapter(), maxPolicyBytes = DEFAULT_MAX_POLICY_BYTES } = {}) {
		this.#git = git;
		this.#maxPolicyBytes = maxPolicyBytes;
	}

	async collect({ directory, commitSha }) {
		const commit = await this.#git.readCommitReviewData({ directory, commitSha });
		const [parentPolicy, currentPolicy] = await Promise.all([
			this.#readPolicySnapshot({ directory, commitSha: commit.parentSha }),
			this.#readPolicySnapshot({ directory, commitSha }),
		]);
		return {
			parentSha: commit.parentSha,
			commit: { sha: commitSha, parent_sha: commit.parentSha, message: commit.message },
			changedPaths: commit.changedPaths,
			diff: commit.diff,
			policySnapshot: selectPolicySnapshot({
				changedPaths: commit.changedPaths,
				parentPolicy,
				currentPolicy,
			}),
		};
	}

	async #readPolicySnapshot({ directory, commitSha }) {
		const paths = (await this.#git.listFilesAtCommit({ directory, commitSha })).filter(isProjectPolicyPath);
		const documents = [];
		for (const path of paths) {
			const content = await this.#git.readFileAtCommit({ directory, commitSha, path });
			if (Buffer.byteLength(content, "utf8") > this.#maxPolicyBytes) continue;
			documents.push({ path, content });
		}
		return { source_sha: commitSha, documents };
	}
}
