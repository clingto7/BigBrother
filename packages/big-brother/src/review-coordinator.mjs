import { buildReviewInput } from "./review-input.mjs";
import { publishReviewFindingIssues } from "./finding-issue-publisher.mjs";
import { publishReviewResult } from "./publisher.mjs";
import { WorkerExecutor } from "./worker-executor.mjs";
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
	#workerExecutor;
	#evidenceProvider;
	#inputBuilder;
	#publisher;
	#findingIssuePublisher;

	constructor({
		workspaceManager,
		runtimeSupervisor,
		workerExecutor = new WorkerExecutor(),
		evidenceProvider,
		inputBuilder = buildReviewInput,
		publisher = publishReviewResult,
		findingIssuePublisher = publishReviewFindingIssues,
	}) {
		this.#workspaceManager = workspaceManager;
		this.#runtimeSupervisor = runtimeSupervisor;
		this.#workerExecutor = workerExecutor;
		this.#evidenceProvider = evidenceProvider;
		this.#inputBuilder = inputBuilder;
		this.#publisher = publisher;
		this.#findingIssuePublisher = findingIssuePublisher;
	}

	async process({ repositoryProfile, job, github, store, signal }) {
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
		const mappedFindingIssues = (store.listFindingIssueStates?.(job.repositoryId) ?? [])
			.filter((issue) => issue.issueNumber != null && issue.publishedLifecycleStatus !== "resolved")
			.map(({ findingId, issueNumber, issueUrl, title, body, labels }) => ({
				findingId,
				issueNumber,
				issueUrl,
				title,
				body,
				labels,
			}));
		const reviewInput = this.#inputBuilder({
			...evidence,
			repositoryId: job.repositoryId,
			commitSha: job.commitSha,
			observedBranches: job.observedBranches,
			canonicalContext,
			externalReviewEvidence: evidence.externalReviewEvidence ?? null,
		});
		const runtimeProfile = { ...repositoryProfile, cwd: workspace.directory };
		const credentialEnvNames = [
			repositoryProfile.credentials?.githubReadTokenEnv,
			repositoryProfile.credentials?.githubStatusTokenEnv,
			repositoryProfile.credentials?.githubCheckRunTokenEnv,
			repositoryProfile.credentials?.gitSshKeyPathEnv,
		].filter((name) => typeof name === "string");
		const attempt = await this.#workerExecutor.runAttempt({ job, reviewInput, signal, excludedEnvKeys: credentialEnvNames });
		if (attempt.status !== "success") {
			recordWorkerAttempt(store, job, attempt);
			const error = new Error(`worker attempt ${attempt.status}: ${attempt.error ?? "no details"}`);
			error.code = attempt.status;
			error.attemptId = attempt.attemptId;
			throw error;
		}
		const workerResult = attempt.result;
		const workerValidation = validateWorkerReviewResult(workerResult);
		if (!workerValidation.ok) {
			const error = workerProtocolError(`invalid worker review result: ${workerValidation.errors.join("; ")}`, attempt.attemptId);
			recordWorkerAttempt(store, job, attempt, error.code, error.message);
			throw error;
		}
		try {
			assertReviewResultIdentity({ repositoryId: job.repositoryId, commitSha: job.commitSha, reviewResult: workerResult });
		} catch (error) {
			const protocolError = workerProtocolError(error.message, attempt.attemptId);
			recordWorkerAttempt(store, job, attempt, protocolError.code, protocolError.message);
			throw protocolError;
		}
		recordWorkerAttempt(store, job, attempt);
		const handle = await this.#runtimeSupervisor.start(
			runtimeProfile,
			repositoryProfile.stateNamespace,
		);
		let reviewResult = await this.#runtimeSupervisor.reconcileReview(handle, {
			reviewInput,
			workerResult,
			canonicalContext,
			mappedFindingIssues,
		});
		try {
			validateReconciledReviewResult({ reviewResult, repositoryId: job.repositoryId, commitSha: job.commitSha });
			validateContextDecisions(store, job, reviewResult);
		} catch (error) {
			if (!isRecoverableContextReconciliationError(error) || typeof this.#runtimeSupervisor.startFreshSession !== "function") throw error;
			await this.#runtimeSupervisor.startFreshSession(handle);
			reviewResult = await this.#runtimeSupervisor.reconcileReview(handle, {
				reviewInput,
				workerResult,
				canonicalContext,
				mappedFindingIssues,
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

		return { reviewInput, workerResult, workerAttempt: attempt, reviewResult, published, findingIssues, workspace };
	}
}

function workerProtocolError(message, attemptId) {
	const error = new Error(message);
	error.code = "protocol_failed";
	error.attemptId = attemptId;
	return error;
}

function recordWorkerAttempt(store, job, attempt, status = attempt.status, error = attempt.error) {
	store.recordWorkerAttempt?.({
		repositoryId: job.repositoryId,
		commitSha: job.commitSha,
		attemptId: attempt.attemptId,
		status,
		inputDigest: attempt.inputDigest,
		error,
	});
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

function isRecoverableContextReconciliationError(error) {
	if (!(error instanceof Error)) return false;
	return /^cannot (correct|supersede|retract) unknown fact:/.test(error.message) ||
		error.message.includes("context decision");
}
