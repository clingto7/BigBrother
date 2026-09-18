import { validateReviewResult } from "./review-contract.mjs";

function githubConclusion(conclusion) {
  if (conclusion === "clean") return "success";
  if (conclusion === "findings" || conclusion === "incomplete") return "neutral";
  throw new Error(`unsupported review conclusion: ${conclusion}`);
}

function statusState(conclusion) {
	if (conclusion === "clean") return "success";
	if (conclusion === "findings") return "failure";
	if (conclusion === "incomplete") return "error";
	throw new Error(`unsupported review conclusion: ${conclusion}`);
}

function locationFor(finding, evidenceById) {
  return finding.evidence_refs
    .map((ref) => evidenceById.get(ref))
    .filter(Boolean)
    .map((evidence) => `${evidence.path}${evidence.line ? `:${evidence.line}` : ""}`)
    .join(", ");
}

function outputFor(reviewResult) {
  const { conclusion, commit_sha: commitSha, observed_branches: branches, findings, evidence } = reviewResult;
  const findingCount = findings.length;
  const summary =
    conclusion === "clean"
      ? "No findings. Message and policy checks passed."
      : `${findingCount} finding${findingCount === 1 ? "" : "s"} requires attention.`;
  const evidenceById = new Map(evidence.map((item) => [item.id, item]));
  const branchText = branches.length > 0 ? branches.join(", ") : "repository scope";
  const findingText = findings
    .map((finding) => `- ${finding.title ?? finding.message ?? finding.id} (${locationFor(finding, evidenceById)})`)
    .join("\n");

  return {
    title: `Big Brother review: ${conclusion}`,
    summary,
    text: [`Reviewed commit \`${commitSha}\` on ${branchText}.`, findingText].filter(Boolean).join("\n\n"),
  };
}

function statusDescription(reviewResult) {
	const { conclusion, findings, message_check: messageCheck } = reviewResult;
	const message =
		conclusion === "clean"
			? "Big Brother: clean"
			: `Big Brother: ${findings.length} finding${findings.length === 1 ? "" : "s"}`;
	const suffix = messageCheck?.status && messageCheck.status !== "pass" ? `; commit message: ${messageCheck.status}` : "";
	return `${message}${suffix}`.slice(0, 140);
}

export async function publishReviewResult({ github, reviewResult, checkRunId, store }) {
  const validation = validateReviewResult(reviewResult);
  if (!validation.ok) throw new Error(`invalid review result: ${validation.errors.join("; ")}`);

	if (typeof github.createCommitStatus === "function") {
		const published = await github.createCommitStatus({
			repositoryId: reviewResult.repository_id,
			commitSha: reviewResult.commit_sha,
			state: statusState(reviewResult.conclusion),
			context: "big-brother/review",
			description: statusDescription(reviewResult),
		});
		return published;
	}

	const conclusion = githubConclusion(reviewResult.conclusion);
  const output = outputFor(reviewResult);
  const job = store?.getReviewJob({ repositoryId: reviewResult.repository_id, commitSha: reviewResult.commit_sha });
  if (store && !job) {
    throw new Error(`review job does not exist: ${reviewResult.repository_id}:${reviewResult.commit_sha}`);
  }
  const storedCheckRunId =
    checkRunId ??
    job?.checkRunId;
  const published =
    storedCheckRunId == null
      ? await github.createCheckRun({
          repositoryId: reviewResult.repository_id,
          name: "Big Brother",
          headSha: reviewResult.commit_sha,
          conclusion,
          output,
        })
      : await github.updateCheckRun({
          repositoryId: reviewResult.repository_id,
          checkRunId: storedCheckRunId,
          conclusion,
          output,
        });

  const publishedCheckRunId = published?.id ?? storedCheckRunId;
  if (store && publishedCheckRunId == null) {
    throw new Error("GitHub Check Run response has no ID");
  }
  if (store) {
    store.recordCheckRun({
      repositoryId: reviewResult.repository_id,
      commitSha: reviewResult.commit_sha,
      checkRunId: publishedCheckRunId,
    });
  }
  return published;
}
