import { buildReviewInput } from "./review-input.mjs";
import { publishReviewFindingIssues } from "./finding-issue-publisher.mjs";
import { publishReviewResult } from "./publisher.mjs";
import {
	assertReviewResultIdentity,
	validateReviewResult,
	validateWorkerReviewResult,
} from "./review-contract.mjs";

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
	#findingIssuePublisher;

	constructor({
		workspaceManager,
		runtimeSupervisor,
		evidenceProvider,
		inputBuilder = buildReviewInput,
		publisher = publishReviewResult,
		findingIssuePublisher = publishReviewFindingIssues,
	}) {
		this.#workspaceManager = workspaceManager;
		this.#runtimeSupervisor = runtimeSupervisor;
		this.#evidenceProvider = evidenceProvider;
		this.#inputBuilder = inputBuilder;
		this.#publisher = publisher;
		this.#findingIssuePublisher = findingIssuePublisher;
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
		const canonicalContext = (store.getContextLedger?.(job.repositoryId) ?? []).filter(
			(fact) => fact.status === "active",
		);
		const reviewInput = this.#inputBuilder({
			...evidence,
			repositoryId: job.repositoryId,
			commitSha: job.commitSha,
			observedBranches: job.observedBranches,
			canonicalContext,
			workspace,
		});
		const runtimeProfile = { ...repositoryProfile, cwd: workspace.directory };
		const handle = await this.#runtimeSupervisor.start(
			runtimeProfile,
			repositoryProfile.stateNamespace,
		);
		const workerResult = await this.#runtimeSupervisor.submitWorkerReview(handle, reviewInput);
		const workerValidation = validateWorkerReviewResult(workerResult);
		if (!workerValidation.ok) throw new Error(`invalid worker review result: ${workerValidation.errors.join("; ")}`);
		assertReviewResultIdentity({
			repositoryId: job.repositoryId,
			commitSha: job.commitSha,
			reviewResult: workerResult,
		});
		let reviewResult = await this.#runtimeSupervisor.reconcileReview(handle, {
			reviewInput,
			workerResult,
			canonicalContext,
		});
		validateReconciledReviewResult({ reviewResult, repositoryId: job.repositoryId, commitSha: job.commitSha });
		try {
			validateContextDecisions(store, job, reviewResult);
		} catch (error) {
			if (!isUnknownContextFactError(error) || typeof this.#runtimeSupervisor.startFreshSession !== "function") throw error;
			await this.#runtimeSupervisor.startFreshSession(handle);
			reviewResult = await this.#runtimeSupervisor.reconcileReview(handle, {
				reviewInput,
				workerResult,
				canonicalContext,
				recoveryNotice: error.message,
			});
			validateReconciledReviewResult({ reviewResult, repositoryId: job.repositoryId, commitSha: job.commitSha });
			validateContextDecisions(store, job, reviewResult);
		}
		const published = await this.#publisher({
			github,
			store,
			reviewResult,
		});
		const findingIssues = await this.#findingIssuePublisher({
			github,
			store,
			reviewResult,
			labels: repositoryProfile.reviewFindingIssueLabels ?? [],
		});
		if (reviewResult.context_decisions?.length > 0) {
			store.recordContextDecisions({
				repositoryId: job.repositoryId,
				commitSha: job.commitSha,
				reviewResult,
			});
		}
		store.recordReviewResult?.({
			repositoryId: job.repositoryId,
			commitSha: job.commitSha,
			reviewResult,
		});

		return { reviewInput, workerResult, reviewResult, published, findingIssues, workspace };
	}
}

function validateReconciledReviewResult({ reviewResult, repositoryId, commitSha }) {
	const validation = validateReviewResult(reviewResult);
	if (!validation.ok) throw new Error(`invalid review result: ${validation.errors.join("; ")}`);
	assertReviewResultIdentity({ repositoryId, commitSha, reviewResult });
}

function validateContextDecisions(store, job, reviewResult) {
	if (reviewResult.context_decisions.length === 0) return;
	store.validateContextDecisions({
		repositoryId: job.repositoryId,
		commitSha: job.commitSha,
		reviewResult,
	});
}

function isUnknownContextFactError(error) {
	return error instanceof Error && /^cannot (correct|supersede|retract) unknown fact:/.test(error.message);
}
