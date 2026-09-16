import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

import {
  buildContextDecisionRecords,
  reconcileContextDecisionRecords,
  reduceContextLedger,
} from "./context-ledger.mjs";

export class SqliteJobStore {
  #db;

  constructor(filePath) {
    if (filePath !== ":memory:") mkdirSync(dirname(filePath), { recursive: true });
    this.#db = new DatabaseSync(filePath);
    this.#db.exec(`
      PRAGMA foreign_keys = ON;
      CREATE TABLE IF NOT EXISTS branches (
        repository_id TEXT NOT NULL,
        branch_name TEXT NOT NULL,
        baseline_sha TEXT NOT NULL,
        cursor_sha TEXT NOT NULL,
        PRIMARY KEY (repository_id, branch_name)
      );
      CREATE TABLE IF NOT EXISTS review_jobs (
        repository_id TEXT NOT NULL,
        commit_sha TEXT NOT NULL,
        status TEXT NOT NULL,
        check_run_id INTEGER,
        PRIMARY KEY (repository_id, commit_sha)
      );
      CREATE TABLE IF NOT EXISTS review_job_branches (
        repository_id TEXT NOT NULL,
        commit_sha TEXT NOT NULL,
        branch_name TEXT NOT NULL,
        PRIMARY KEY (repository_id, commit_sha, branch_name),
        FOREIGN KEY (repository_id, commit_sha)
          REFERENCES review_jobs (repository_id, commit_sha)
      );
      CREATE TABLE IF NOT EXISTS context_ledger_decisions (
        repository_id TEXT NOT NULL,
        decision_id TEXT NOT NULL,
        fact_id TEXT NOT NULL,
        action TEXT NOT NULL,
        statement TEXT,
        rationale TEXT,
        source_commit_sha TEXT NOT NULL,
        source_review_id TEXT NOT NULL,
        evidence_json TEXT NOT NULL,
        PRIMARY KEY (repository_id, decision_id)
      );
      CREATE TABLE IF NOT EXISTS review_finding_issues (
        repository_id TEXT NOT NULL,
        finding_id TEXT NOT NULL,
        source_commit_sha TEXT NOT NULL,
        issue_title TEXT NOT NULL,
        issue_body TEXT NOT NULL,
        labels_json TEXT NOT NULL,
        issue_number INTEGER,
        issue_url TEXT,
        publication_status TEXT NOT NULL,
        last_error TEXT,
        PRIMARY KEY (repository_id, finding_id)
      );
    `);
    const columns = this.#db.prepare(`PRAGMA table_info(review_jobs)`).all().map((row) => row.name);
    if (!columns.includes("check_run_id")) this.#db.exec(`ALTER TABLE review_jobs ADD COLUMN check_run_id INTEGER`);
  }

  enrollBranch({ repositoryId, branchName, headSha }) {
    const insert = this.#db.prepare(`
      INSERT INTO branches (repository_id, branch_name, baseline_sha, cursor_sha)
      VALUES (?, ?, ?, ?)
      ON CONFLICT (repository_id, branch_name) DO NOTHING
    `);
    const result = insert.run(repositoryId, branchName, headSha, headSha);
    const branch = this.getBranch({ repositoryId, branchName });
    return { created: Number(result.changes) === 1, baselineSha: branch.baselineSha };
  }

  getBranch({ repositoryId, branchName }) {
    const row = this.#db
      .prepare(`SELECT repository_id, branch_name, baseline_sha, cursor_sha FROM branches WHERE repository_id = ? AND branch_name = ?`)
      .get(repositoryId, branchName);
    return row
      ? {
          repositoryId: row.repository_id,
          branchName: row.branch_name,
          baselineSha: row.baseline_sha,
          cursorSha: row.cursor_sha,
        }
      : undefined;
  }

  advanceBranch({ repositoryId, branchName, headSha }) {
    const result = this.#db
      .prepare(`UPDATE branches SET cursor_sha = ? WHERE repository_id = ? AND branch_name = ?`)
      .run(headSha, repositoryId, branchName);
    if (Number(result.changes) !== 1) throw new Error(`branch is not enrolled: ${repositoryId}:${branchName}`);
  }

  admitCommitReview({ repositoryId, commitSha, branchName }) {
    if (!this.getBranch({ repositoryId, branchName })) {
      throw new Error(`branch is not enrolled: ${repositoryId}:${branchName}`);
    }

    const result = this.#db
      .prepare(`
        INSERT INTO review_jobs (repository_id, commit_sha, status)
        VALUES (?, ?, 'pending')
        ON CONFLICT (repository_id, commit_sha) DO NOTHING
      `)
      .run(repositoryId, commitSha);
    this.#db
      .prepare(`
        INSERT INTO review_job_branches (repository_id, commit_sha, branch_name)
        VALUES (?, ?, ?)
        ON CONFLICT (repository_id, commit_sha, branch_name) DO NOTHING
      `)
      .run(repositoryId, commitSha, branchName);

    return {
      created: Number(result.changes) === 1,
      job: this.getReviewJob({ repositoryId, commitSha }),
    };
  }

  getReviewJob({ repositoryId, commitSha }) {
    const job = this.#db
      .prepare(`SELECT repository_id, commit_sha, status, check_run_id FROM review_jobs WHERE repository_id = ? AND commit_sha = ?`)
      .get(repositoryId, commitSha);
    if (!job) return undefined;
    const branches = this.#db
      .prepare(`
        SELECT branch_name FROM review_job_branches
        WHERE repository_id = ? AND commit_sha = ?
        ORDER BY rowid
      `)
      .all(repositoryId, commitSha)
      .map((row) => row.branch_name);
    return {
      repositoryId: job.repository_id,
      commitSha: job.commit_sha,
      observedBranches: branches,
      status: job.status,
      checkRunId: job.check_run_id ?? null,
    };
  }

  recordCheckRun({ repositoryId, commitSha, checkRunId }) {
    const result = this.#db
      .prepare(`UPDATE review_jobs SET check_run_id = ? WHERE repository_id = ? AND commit_sha = ?`)
      .run(checkRunId, repositoryId, commitSha);
    if (Number(result.changes) !== 1) throw new Error(`review job does not exist: ${repositoryId}:${commitSha}`);
  }

  setReviewJobStatus({ repositoryId, commitSha, status }) {
    if (!REVIEW_JOB_STATUSES.has(status)) throw new Error(`unsupported review job status: ${status}`);
    const result = this.#db
      .prepare(`UPDATE review_jobs SET status = ? WHERE repository_id = ? AND commit_sha = ?`)
      .run(status, repositoryId, commitSha);
    if (Number(result.changes) !== 1) throw new Error(`review job does not exist: ${repositoryId}:${commitSha}`);
  }

  listReviewJobs(repositoryId) {
    return this.#db
      .prepare(`SELECT commit_sha FROM review_jobs WHERE repository_id = ? ORDER BY rowid`)
      .all(repositoryId)
      .map((row) => this.getReviewJob({ repositoryId, commitSha: row.commit_sha }));
  }

  getFindingIssue({ repositoryId, findingId }) {
    const row = this.#db.prepare(`
      SELECT issue_number, issue_url, publication_status, last_error
      FROM review_finding_issues
      WHERE repository_id = ? AND finding_id = ?
    `).get(repositoryId, findingId);
    return row
      ? {
          repositoryId,
          findingId,
          issueNumber: row.issue_number ?? undefined,
          issueUrl: row.issue_url ?? undefined,
          status: row.publication_status,
          lastError: row.last_error ?? undefined,
        }
      : undefined;
  }

  stageFindingIssue({ repositoryId, findingId, commitSha, title, body, labels }) {
    this.#db.prepare(`
      INSERT INTO review_finding_issues (
        repository_id, finding_id, source_commit_sha, issue_title, issue_body,
        labels_json, publication_status
      ) VALUES (?, ?, ?, ?, ?, ?, 'pending')
      ON CONFLICT (repository_id, finding_id) DO UPDATE SET
        source_commit_sha = excluded.source_commit_sha,
        issue_title = excluded.issue_title,
        issue_body = excluded.issue_body,
        labels_json = excluded.labels_json,
        publication_status = CASE
          WHEN review_finding_issues.issue_number IS NULL THEN 'pending'
          ELSE review_finding_issues.publication_status
        END,
        last_error = CASE
          WHEN review_finding_issues.issue_number IS NULL THEN NULL
          ELSE review_finding_issues.last_error
        END
    `).run(repositoryId, findingId, commitSha, title, body, JSON.stringify(labels));
  }

  listRetryableFindingIssues(repositoryId) {
    return this.#db.prepare(`
      SELECT finding_id, source_commit_sha, issue_title, issue_body, labels_json,
             publication_status, last_error
      FROM review_finding_issues
      WHERE repository_id = ? AND issue_number IS NULL
      ORDER BY rowid
    `).all(repositoryId).map((row) => ({
      repositoryId,
      findingId: row.finding_id,
      commitSha: row.source_commit_sha,
      title: row.issue_title,
      body: row.issue_body,
      labels: JSON.parse(row.labels_json),
      status: row.publication_status,
      lastError: row.last_error ?? undefined,
    }));
  }

  recordFindingIssue({ repositoryId, findingId, issueNumber, issueUrl }) {
    this.#db.prepare(`
      UPDATE review_finding_issues
      SET issue_number = ?, issue_url = ?, publication_status = 'published', last_error = NULL
      WHERE repository_id = ? AND finding_id = ?
    `).run(issueNumber, issueUrl ?? null, repositoryId, findingId);
  }

  recordFindingIssueFailure({ repositoryId, findingId, error }) {
    this.#db.prepare(`
      UPDATE review_finding_issues
      SET publication_status = 'failed', last_error = ?
      WHERE repository_id = ? AND finding_id = ?
    `).run(error, repositoryId, findingId);
  }

  recordContextDecisions({ repositoryId, commitSha, reviewResult }) {
    const insert = this.#db.prepare(`
      INSERT INTO context_ledger_decisions (
        repository_id, decision_id, fact_id, action, statement, rationale,
        source_commit_sha, source_review_id, evidence_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    this.#db.exec("BEGIN IMMEDIATE");
    try {
      for (const record of this.#contextDecisionAdditions({ repositoryId, commitSha, reviewResult })) {
        insert.run(
          record.repositoryId,
          record.decisionId,
          record.factId,
          record.action,
          record.statement ?? null,
          record.rationale ?? null,
          record.source.commitSha,
          record.source.reviewId,
          JSON.stringify(record.evidence),
        );
      }
      this.#db.exec("COMMIT");
    } catch (error) {
      this.#db.exec("ROLLBACK");
      throw error;
    }
  }

  validateContextDecisions(input) {
    this.#contextDecisionAdditions(input);
  }

  getContextLedger(repositoryId) {
    return reduceContextLedger(this.#listContextDecisionRecords(repositoryId));
  }

  #listContextDecisionRecords(repositoryId) {
    const rows = this.#db.prepare(`
      SELECT decision_id, fact_id, action, statement, rationale,
             source_commit_sha, source_review_id, evidence_json
      FROM context_ledger_decisions
      WHERE repository_id = ?
      ORDER BY rowid
    `).all(repositoryId);
    return rows.map((row) => ({
      repositoryId,
      decisionId: row.decision_id,
      factId: row.fact_id,
      action: row.action,
      statement: row.statement ?? undefined,
      rationale: row.rationale ?? undefined,
      source: {
        repositoryId,
        commitSha: row.source_commit_sha,
        reviewId: row.source_review_id,
      },
      evidence: JSON.parse(row.evidence_json),
    }));
  }

  #contextDecisionAdditions({ repositoryId, commitSha, reviewResult }) {
    const existing = this.#listContextDecisionRecords(repositoryId);
    const proposed = buildContextDecisionRecords({ repositoryId, commitSha, reviewResult });
    return reconcileContextDecisionRecords(existing, proposed);
  }

  close() {
    this.#db.close();
  }
}

const REVIEW_JOB_STATUSES = new Set(["pending", "reviewing", "completed", "failed"]);
