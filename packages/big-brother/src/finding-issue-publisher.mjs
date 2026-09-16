import { findingIssueIntentAction } from "./review-contract.mjs";

export async function publishReviewFindingIssues({ github, store, reviewResult, labels = [] }) {
	const findingsById = new Map(reviewResult.findings.map((finding) => [finding.id, finding]));
	const evidenceById = new Map(reviewResult.evidence.map((item) => [item.id, item]));
	const publications = [];

	for (const intent of reviewResult.finding_issue_intents ?? []) {
		const findingId = intent.finding_id;
		if (findingIssueIntentAction(intent) === "resolve") {
			const existing = store.getFindingIssue({ repositoryId: reviewResult.repository_id, findingId });
			if (!existing) continue;
			store.stageFindingIssueResolution({
				repositoryId: reviewResult.repository_id,
				findingId,
				commitSha: reviewResult.commit_sha,
			});
			const state = store.getFindingIssueState({ repositoryId: reviewResult.repository_id, findingId });
			await attemptPublication({ github, store, publication: state, reconcile: false });
			publications.push(store.getFindingIssue({ repositoryId: reviewResult.repository_id, findingId }));
			continue;
		}

		const finding = findingsById.get(findingId);
		if (!finding) throw new Error(`finding issue intent cites unknown finding: ${findingId}`);
		const publication = {
			repositoryId: reviewResult.repository_id,
			findingId,
			commitSha: reviewResult.commit_sha,
			title: finding.title ?? finding.message ?? finding.id,
			body: issueBody({ reviewResult, finding, evidenceById }),
			labels,
			lifecycleStatus: "active",
		};
		store.stageFindingIssue(publication);
		const state = store.getFindingIssueState({ repositoryId: publication.repositoryId, findingId });
		await attemptPublication({ github, store, publication: state, reconcile: false });
		publications.push(store.getFindingIssue({
			repositoryId: reviewResult.repository_id,
			findingId,
		}));
	}

	return publications;
}

export async function retryReviewFindingIssues({ github, store, repositoryId }) {
	let published = 0;
	for (const publication of store.listRetryableFindingIssues(repositoryId)) {
		const result = await attemptPublication({ github, store, publication, reconcile: true });
		if (result?.status === "published") published += 1;
	}
	return published;
}

async function attemptPublication({ github, store, publication, reconcile }) {
	const { repositoryId, findingId, title, body, labels, lifecycleStatus = "active" } = publication;
	try {
		let issue = publication.issueNumber == null
			? undefined
			: { number: publication.issueNumber, html_url: publication.issueUrl };
		let created = false;
		if (reconcile) {
			if (typeof github.findIssueByFindingId !== "function") {
				throw new Error("GitHub adapter cannot reconcile an indeterminate finding issue publication");
			}
			issue = await github.findIssueByFindingId({ repositoryId, findingId });
			if (!issue && publication.issueNumber != null) {
				throw new Error(`mapped GitHub Review finding issue was not found: ${repositoryId}:${findingId}`);
			}
		}
		if (!issue && publication.issueNumber == null) {
			issue = await github.createIssue({ repositoryId, title, body, labels });
			created = true;
		}
		if (!Number.isInteger(issue?.number)) throw new Error("GitHub Issue response has no issue number");
		if (publication.issueNumber == null) {
			store.recordFindingIssueMapping({
				repositoryId,
				findingId,
				issueNumber: issue.number,
				issueUrl: issue.html_url,
			});
		}

		const desiredState = lifecycleStatus === "resolved" ? "closed" : "open";
		const updateRequired = shouldUpdateIssue({ issue, publication, desiredState, created, reconcile });
		if (updateRequired && typeof github.updateIssue !== "function") {
			throw new Error("GitHub adapter cannot update a mapped finding issue");
		}
		if (updateRequired) {
			const updated = await github.updateIssue({
				repositoryId,
				issueNumber: issue.number,
				title,
				body,
				labels,
				state: desiredState,
			});
			issue = { ...issue, ...updated };
		}
		store.recordFindingIssue({
			repositoryId,
			findingId,
			issueNumber: issue.number,
			issueUrl: issue.html_url,
		});
	} catch (error) {
		store.recordFindingIssueFailure({ repositoryId, findingId, error: publicationError(error) });
	}
	return store.getFindingIssue({ repositoryId, findingId });
}

function shouldUpdateIssue({ issue, publication, desiredState, created, reconcile }) {
	if (created) return desiredState === "closed";
	if (issue.state === undefined && issue.body === undefined && issue.title === undefined && issue.labels === undefined) {
		// A marker-only reconciliation response proves identity but cannot prove
		// whether the idempotent update already reached GitHub.
		return !reconcile && publication.status !== "published";
	}
	return issue.state !== desiredState ||
		(issue.title !== undefined && issue.title !== publication.title) ||
		(issue.body !== undefined && issue.body !== publication.body) ||
		(issue.labels !== undefined && labelsFor(issue.labels).join("\u0000") !== labelsFor(publication.labels).join("\u0000"));
}

function labelsFor(labels) {
	return (labels ?? []).map((label) => typeof label === "string" ? label : label?.name).filter(Boolean);
}

function publicationError(error) {
	const message = error instanceof Error ? error.message : String(error);
	if (message.startsWith("GitHub API request failed")) {
		return message.replace(/^GitHub API request failed/, "GitHub Review finding issue publication failed");
	}
	return `GitHub Review finding issue publication failed: ${message}`;
}

function issueBody({ reviewResult, finding, evidenceById }) {
	const evidence = finding.evidence_refs.map((evidenceId) => evidenceById.get(evidenceId));
	const evidenceLines = evidence.map((item) => {
		const location = `${item.path}${item.line ? `:${item.line}` : ""}`;
		const description = item.description ?? item.message;
		return `- \`${location}\`${description ? ` — ${description}` : ""}`;
	});
	const limitationLines = reviewResult.limitations.map((limitation) =>
		`- ${typeof limitation === "string" ? limitation : limitation.description ?? limitation.message ?? JSON.stringify(limitation)}`
	);

	return [
		`<!-- big-brother-finding-id: ${finding.id} -->`,
		`**Stable finding ID:** \`${finding.id}\``,
		`**Reviewed commit:** \`${reviewResult.commit_sha}\``,
		"",
		"## Finding",
		finding.message ?? finding.title ?? finding.id,
		"",
		"## Evidence",
		...evidenceLines,
		"",
		"## Limitations",
		...(limitationLines.length > 0 ? limitationLines : ["- None reported."]),
	].join("\n");
}
