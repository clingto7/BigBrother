import {
  buildContextDecisionRecords,
  reconcileContextDecisionRecords,
  reduceContextLedger,
} from "./context-ledger.mjs";

function copy(value) {
  return structuredClone(value);
}

export class InMemoryJobStore {
  // ponytail: in-memory only; replace at the Job Store seam before multi-process watch.
  #branches = new Map();
  #reviewJobs = new Map();
  #reviewResults = new Map();
  #contextDecisions = new Map();
  #findingIssues = new Map();

  enrollBranch({ repositoryId, branchName, headSha }) {
    const key = `${repositoryId}:${branchName}`;
    if (this.#branches.has(key)) {
      return { created: false, baselineSha: this.#branches.get(key).baselineSha };
    }

    this.#branches.set(key, {
      repositoryId,
      branchName,
      baselineSha: headSha,
      cursorSha: headSha,
    });
    return { created: true, baselineSha: headSha };
  }

  admitCommitReview({ repositoryId, commitSha, branchName }) {
    const branchKey = `${repositoryId}:${branchName}`;
    if (!this.#branches.has(branchKey)) {
      throw new Error(`branch is not enrolled: ${repositoryId}:${branchName}`);
    }

    const key = `${repositoryId}:${commitSha}`;
    const existing = this.#reviewJobs.get(key);
    if (existing) {
      if (!existing.observedBranches.includes(branchName)) {
        existing.observedBranches.push(branchName);
      }
      return { created: false, job: copy(existing) };
    }

    const job = {
      repositoryId,
      commitSha,
      observedBranches: [branchName],
      status: "pending",
      checkRunId: null,
    };
    this.#reviewJobs.set(key, job);
    return { created: true, job: copy(job) };
  }

  getBranch({ repositoryId, branchName }) {
    const branch = this.#branches.get(`${repositoryId}:${branchName}`);
    return branch ? copy(branch) : undefined;
  }

  advanceBranch({ repositoryId, branchName, headSha }) {
    const key = `${repositoryId}:${branchName}`;
    const branch = this.#branches.get(key);
    if (!branch) throw new Error(`branch is not enrolled: ${repositoryId}:${branchName}`);
    branch.cursorSha = headSha;
  }

  getReviewJob({ repositoryId, commitSha }) {
    const job = this.#reviewJobs.get(`${repositoryId}:${commitSha}`);
    return job ? copy(job) : undefined;
  }

  recordCheckRun({ repositoryId, commitSha, checkRunId }) {
    const job = this.#reviewJobs.get(`${repositoryId}:${commitSha}`);
    if (!job) throw new Error(`review job does not exist: ${repositoryId}:${commitSha}`);
    job.checkRunId = checkRunId;
  }

  setReviewJobStatus({ repositoryId, commitSha, status }) {
    if (!REVIEW_JOB_STATUSES.has(status)) throw new Error(`unsupported review job status: ${status}`);
    const job = this.#reviewJobs.get(`${repositoryId}:${commitSha}`);
    if (!job) throw new Error(`review job does not exist: ${repositoryId}:${commitSha}`);
    job.status = status;
  }

  recordReviewResult({ repositoryId, commitSha, reviewResult }) {
    assertReviewResultIdentity({ repositoryId, commitSha, reviewResult });
    if (!this.#reviewJobs.has(`${repositoryId}:${commitSha}`)) {
      throw new Error(`review job does not exist: ${repositoryId}:${commitSha}`);
    }
    this.#reviewResults.set(`${repositoryId}:${commitSha}`, copy(reviewResult));
  }

  getReviewResult({ repositoryId, commitSha }) {
    const result = this.#reviewResults.get(`${repositoryId}:${commitSha}`);
    return result ? copy(result) : undefined;
  }

  listReviewJobs(repositoryId) {
    return [...this.#reviewJobs.values()]
      .filter((job) => job.repositoryId === repositoryId)
      .map(copy);
  }

  getFindingIssue({ repositoryId, findingId }) {
    const issue = this.#findingIssues.get(`${repositoryId}:${findingId}`);
    if (!issue) return undefined;
    return copy({
      repositoryId: issue.repositoryId,
      findingId: issue.findingId,
      issueNumber: issue.issueNumber,
      issueUrl: issue.issueUrl,
      status: issue.status,
      lastError: issue.lastError,
    });
  }

  getFindingIssueState({ repositoryId, findingId }) {
    const issue = this.#findingIssues.get(`${repositoryId}:${findingId}`);
    if (!issue) return undefined;
    return copy({
      ...this.getFindingIssue({ repositoryId, findingId }),
      commitSha: issue.commitSha,
      title: issue.title,
      body: issue.body,
      labels: issue.labels,
      lifecycleStatus: issue.lifecycleStatus,
      publishedCommitSha: issue.publishedCommitSha,
      publishedTitle: issue.publishedTitle,
      publishedBody: issue.publishedBody,
      publishedLabels: issue.publishedLabels,
      publishedLifecycleStatus: issue.publishedLifecycleStatus,
    });
  }

  stageFindingIssue({ repositoryId, findingId, commitSha, title, body, labels, lifecycleStatus = "active" }) {
    const key = `${repositoryId}:${findingId}`;
    const existing = this.#findingIssues.get(key);
    if (existing) {
      const changed =
        existing.commitSha !== commitSha ||
        existing.title !== title ||
        existing.body !== body ||
        JSON.stringify(existing.labels) !== JSON.stringify(labels) ||
        existing.lifecycleStatus !== lifecycleStatus;
      Object.assign(existing, { commitSha, title, body, labels: copy(labels), lifecycleStatus });
      if (existing.issueNumber == null) {
        existing.status = "pending";
        existing.lastError = undefined;
      } else if (changed) {
        existing.status = "pending";
        existing.lastError = undefined;
      }
      return;
    }
    this.#findingIssues.set(key, {
      repositoryId,
      findingId,
      issueNumber: undefined,
      issueUrl: undefined,
      status: "pending",
      lastError: undefined,
      commitSha,
      title,
      body,
      labels: copy(labels),
      lifecycleStatus,
      publishedCommitSha: undefined,
      publishedTitle: undefined,
      publishedBody: undefined,
      publishedLabels: undefined,
      publishedLifecycleStatus: undefined,
    });
  }

  stageFindingIssueResolution({ repositoryId, findingId, commitSha }) {
    const issue = this.#findingIssues.get(`${repositoryId}:${findingId}`);
    if (!issue) return;
    issue.commitSha = commitSha;
    issue.lifecycleStatus = "resolved";
    if (issue.issueNumber == null) {
      issue.status = "pending";
      issue.lastError = undefined;
    } else if (issue.publishedLifecycleStatus !== "resolved") {
      issue.status = "pending";
      issue.lastError = undefined;
    }
  }

  listRetryableFindingIssues(repositoryId) {
    return [...this.#findingIssues.values()]
      .filter((issue) =>
        issue.repositoryId === repositoryId &&
        (issue.status === "pending" || issue.status === "failed")
      )
      .map(copy);
  }

  recordFindingIssue({ repositoryId, findingId, issueNumber, issueUrl }) {
    const key = `${repositoryId}:${findingId}`;
    const existing = this.#findingIssues.get(key);
    if (!existing) throw new Error(`finding issue publication does not exist: ${repositoryId}:${findingId}`);
    this.#findingIssues.set(key, {
      ...existing,
      issueNumber,
      issueUrl,
      status: "published",
      lastError: undefined,
      publishedCommitSha: existing.commitSha,
      publishedTitle: existing.title,
      publishedBody: existing.body,
      publishedLabels: copy(existing.labels),
      publishedLifecycleStatus: existing.lifecycleStatus,
    });
  }

  recordFindingIssueMapping({ repositoryId, findingId, issueNumber, issueUrl }) {
    const key = `${repositoryId}:${findingId}`;
    const existing = this.#findingIssues.get(key);
    if (!existing) throw new Error(`finding issue publication does not exist: ${repositoryId}:${findingId}`);
    existing.issueNumber = issueNumber;
    existing.issueUrl = issueUrl;
  }

  recordFindingIssueFailure({ repositoryId, findingId, error }) {
    const key = `${repositoryId}:${findingId}`;
    const issue = this.#findingIssues.get(key);
    if (!issue) throw new Error(`finding issue publication does not exist: ${repositoryId}:${findingId}`);
    issue.status = "failed";
    issue.lastError = error;
  }

  recordContextDecisions({ repositoryId, commitSha, reviewResult }) {
    for (const record of this.#contextDecisionAdditions({ repositoryId, commitSha, reviewResult })) {
      this.#contextDecisions.set(`${repositoryId}:${record.decisionId}`, record);
    }
  }

  validateContextDecisions(input) {
    this.#contextDecisionAdditions(input);
  }

  #contextDecisionAdditions({ repositoryId, commitSha, reviewResult }) {
    const existing = [...this.#contextDecisions.values()].filter((record) => record.repositoryId === repositoryId);
    const proposed = buildContextDecisionRecords({ repositoryId, commitSha, reviewResult });
    return reconcileContextDecisionRecords(existing, proposed);
  }

  getContextLedger(repositoryId) {
    const records = [...this.#contextDecisions.values()].filter((record) => record.repositoryId === repositoryId);
    return reduceContextLedger(records);
  }
}

const REVIEW_JOB_STATUSES = new Set(["pending", "reviewing", "completed", "failed"]);

function assertReviewResultIdentity({ repositoryId, commitSha, reviewResult }) {
  if (
    !reviewResult ||
    reviewResult.repository_id !== repositoryId ||
    reviewResult.commit_sha !== commitSha
  ) {
    throw new Error(`review result does not match review job: ${repositoryId}:${commitSha}`);
  }
}
