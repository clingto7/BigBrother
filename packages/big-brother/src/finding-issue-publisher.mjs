export async function publishReviewFindingIssues({ github, store, reviewResult, labels = [] }) {
	const findingsById = new Map(reviewResult.findings.map((finding) => [finding.id, finding]));
	const evidenceById = new Map(reviewResult.evidence.map((item) => [item.id, item]));
	const publications = [];

	for (const intent of reviewResult.finding_issue_intents ?? []) {
		const finding = findingsById.get(intent.finding_id);
		if (!finding) throw new Error(`finding issue intent cites unknown finding: ${intent.finding_id}`);
		const existing = store.getFindingIssue({
			repositoryId: reviewResult.repository_id,
			findingId: intent.finding_id,
		});
		if (existing?.issueNumber != null) {
			publications.push(existing);
			continue;
		}

		const publication = {
			repositoryId: reviewResult.repository_id,
			findingId: intent.finding_id,
			commitSha: reviewResult.commit_sha,
			title: finding.title ?? finding.message ?? finding.id,
			body: issueBody({ reviewResult, finding, evidenceById }),
			labels,
		};
		store.stageFindingIssue(publication);
		await attemptPublication({ github, store, publication, reconcile: false });
		publications.push(store.getFindingIssue({
			repositoryId: reviewResult.repository_id,
			findingId: intent.finding_id,
		}));
	}

	return publications;
}

export async function retryReviewFindingIssues({ github, store, repositoryId }) {
	let published = 0;
	for (const publication of store.listRetryableFindingIssues(repositoryId)) {
		const result = await attemptPublication({ github, store, publication, reconcile: true });
		if (result?.issueNumber != null) published += 1;
	}
	return published;
}

async function attemptPublication({ github, store, publication, reconcile }) {
	const { repositoryId, findingId, title, body, labels } = publication;
	try {
		let issue;
		if (reconcile) {
			if (typeof github.findIssueByFindingId !== "function") {
				throw new Error("GitHub adapter cannot reconcile an indeterminate finding issue publication");
			}
			issue = await github.findIssueByFindingId({ repositoryId, findingId });
		}
		issue ??= await github.createIssue({ repositoryId, title, body, labels });
		if (!Number.isInteger(issue?.number)) throw new Error("GitHub Issue response has no issue number");
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
