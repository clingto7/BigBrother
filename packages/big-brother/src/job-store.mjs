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
    if (reviewResult.repository_id !== repositoryId || reviewResult.commit_sha !== commitSha) {
      throw new Error("context decision source does not match the repository cycle");
    }
    const evidenceById = new Map(reviewResult.evidence.map((item) => [item?.id, item]));
    const facts = new Map(this.getContextLedger(repositoryId).map((fact) => [fact.factId, fact]));
    const staged = [];
    for (const decision of reviewResult.context_decisions) {
      const key = `${repositoryId}:${decision.id}`;
      const record = {
        repositoryId,
        decisionId: decision.id,
        factId: decision.fact_id,
        action: decision.action,
        statement: decision.statement,
        rationale: decision.rationale,
        source: { repositoryId, commitSha, reviewId: `${repositoryId}:${commitSha}` },
        evidence: decision.evidence_refs.map((id) => evidenceById.get(id)),
      };
      const existing = this.#contextDecisions.get(key) ?? staged.find(([stagedKey]) => stagedKey === key)?.[1];
      if (existing) {
        if (JSON.stringify(existing) !== JSON.stringify(record)) {
          throw new Error(`context decision id was reused with different content: ${decision.id}`);
        }
        continue;
      }

      const fact = facts.get(decision.fact_id);
      if (decision.action === "admit") {
        if (fact) throw new Error(`cannot admit existing fact: ${decision.fact_id}`);
      } else if (!fact) {
        throw new Error(`cannot ${decision.action} unknown fact: ${decision.fact_id}`);
      } else if (fact.status !== "active") {
        throw new Error(`cannot ${decision.action} ${fact.status} fact: ${decision.fact_id}`);
      }
      staged.push([key, record]);
      facts.set(decision.fact_id, {
        factId: decision.fact_id,
        statement: decision.statement ?? fact?.statement,
        status: decision.action === "supersede" ? "superseded" : decision.action === "retract" ? "retracted" : "active",
      });
    }
    for (const [key, record] of staged) this.#contextDecisions.set(key, record);
  }

  getContextLedger(repositoryId) {
    const facts = new Map();
    for (const record of this.#contextDecisions.values()) {
      if (record.repositoryId !== repositoryId) continue;
      const fact = facts.get(record.factId) ?? {
        factId: record.factId,
        statement: undefined,
        status: "active",
        history: [],
      };
      fact.statement = record.statement ?? fact.statement;
      fact.status = record.action === "supersede" ? "superseded" : record.action === "retract" ? "retracted" : "active";
      fact.history.push({
        decisionId: record.decisionId,
        action: record.action,
        statement: record.statement,
        rationale: record.rationale,
        source: copy(record.source),
        evidence: copy(record.evidence),
      });
      facts.set(record.factId, fact);
    }
    return copy([...facts.values()]);
  }
}

const REVIEW_JOB_STATUSES = new Set(["pending", "reviewing", "completed", "failed"]);
