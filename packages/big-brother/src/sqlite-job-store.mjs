import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

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

  close() {
    this.#db.close();
  }
}

const REVIEW_JOB_STATUSES = new Set(["pending", "reviewing", "completed", "failed"]);
