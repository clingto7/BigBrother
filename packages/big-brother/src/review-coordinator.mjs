import { buildReviewInput } from "./review-input.mjs";
import { publishReviewResult } from "./publisher.mjs";

/**
 * Coordinates one admitted job without putting polling or GitHub knowledge in
 * Prime. Evidence collection remains an injected Adapter because its source
 * may be local Git, GitHub REST, or a later bounded reader.
 */
export class ReviewCoordinator {
	#workspaceManager;
	#runtimeSupervisor;
	#evidenceProvider;
	#inputBuilder;
	#publisher;

	constructor({
		workspaceManager,
		runtimeSupervisor,
		evidenceProvider,
		inputBuilder = buildReviewInput,
		publisher = publishReviewResult,
	}) {
		this.#workspaceManager = workspaceManager;
		this.#runtimeSupervisor = runtimeSupervisor;
		this.#evidenceProvider = evidenceProvider;
		this.#inputBuilder = inputBuilder;
		this.#publisher = publisher;
	}

	async process({ repositoryProfile, job, github, store }) {
		if (!repositoryProfile?.repositoryId) throw new Error("repository profile requires repositoryId");
		if (repositoryProfile.repositoryId !== job?.repositoryId) {
			throw new Error("repository profile and review job repository do not match");
		}

		const workspace = await this.#workspaceManager.materialize({
			repositoryId: job.repositoryId,
			cloneUrl: repositoryProfile.cloneUrl,
			commitSha: job.commitSha,
		});
		const evidence = await this.#evidenceProvider({
			repositoryProfile,
			job,
			workspace,
		});
		const reviewInput = this.#inputBuilder({
			...evidence,
			repositoryId: job.repositoryId,
			commitSha: job.commitSha,
			observedBranches: job.observedBranches,
			workspace,
		});
		const runtimeProfile = { ...repositoryProfile, cwd: workspace.directory };
		const handle = await this.#runtimeSupervisor.start(
			runtimeProfile,
			repositoryProfile.stateNamespace,
		);
		const reviewResult = await this.#runtimeSupervisor.submitReview(handle, reviewInput);
		const published = await this.#publisher({
			github,
			store,
			reviewResult,
		});

		return { reviewInput, reviewResult, published, workspace };
	}
}
