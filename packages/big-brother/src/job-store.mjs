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
  #contextDecisions = new Map();

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

  listReviewJobs(repositoryId) {
    return [...this.#reviewJobs.values()]
      .filter((job) => job.repositoryId === repositoryId)
      .map(copy);
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
