import { execFile as nodeExecFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { promisify } from "node:util";

const defaultExecFile = promisify(nodeExecFile);

function workspaceDirectory(rootDir, repositoryId, commitSha) {
  const key = createHash("sha256").update(`${repositoryId}:${commitSha}`).digest("hex").slice(0, 32);
  return join(rootDir, key);
}

export class WorkspaceManager {
  #rootDir;
  #git;

  constructor({ rootDir, git }) {
    this.#rootDir = rootDir;
    this.#git = git;
    mkdirSync(rootDir, { recursive: true });
  }

  async materialize({ repositoryId, cloneUrl, commitSha }) {
    // ponytail: one workspace per commit avoids cross-review mutation; cleanup comes with lifecycle supervision.
    const directory = workspaceDirectory(this.#rootDir, repositoryId, commitSha);
    await this.#git.ensureRepository({ directory, cloneUrl });
    await this.#git.fetchCommit({ directory, commitSha });
    await this.#git.checkoutDetached({ directory, commitSha });
    const actualSha = await this.#git.revParse({ directory });
    if (actualSha !== commitSha) {
      throw new Error(`workspace commit mismatch: expected ${commitSha}, got ${actualSha}`);
    }
    return { directory, commitSha };
  }
}

export class GitCliAdapter {
  #exec;
  #gitBinary;
  #env;

  constructor({ execFile = defaultExecFile, gitBinary = "git", sshKeyPath, env } = {}) {
    this.#exec = execFile;
    this.#gitBinary = gitBinary;
    this.#env = {
      ...(env ?? {}),
      ...(sshKeyPath ? { GIT_SSH_COMMAND: `ssh -i ${shellQuote(sshKeyPath)} -o IdentitiesOnly=yes` } : {}),
    };
  }

  async ensureRepository({ directory, cloneUrl }) {
    mkdirSync(dirname(directory), { recursive: true });
    if (existsSync(directory)) {
      if (existsSync(join(directory, ".git"))) return;
      throw new Error(`workspace directory is not a Git repository: ${directory}`);
    }
    await this.#run(["clone", "--no-tags", "--no-checkout", "--", cloneUrl, directory]);
  }

  async fetchCommit({ directory, commitSha }) {
    await this.#run(["-C", directory, "fetch", "--no-tags", "origin", commitSha]);
  }

  async checkoutDetached({ directory, commitSha }) {
    await this.#run(["-C", directory, "checkout", "--detach", "--force", commitSha]);
  }

  async revParse({ directory }) {
    const result = await this.#run(["-C", directory, "rev-parse", "HEAD"]);
    return result.stdout.trim();
  }

  async readCommitReviewData({ directory, commitSha }) {
    const parents = await this.#run(["-C", directory, "rev-list", "--parents", "-n", "1", commitSha]);
    const [, parentSha] = parents.stdout.trim().split(/\s+/);
    if (!parentSha) throw new Error(`root commit review is not supported yet: ${commitSha}`);
    const [message, paths, diff] = await Promise.all([
      this.#run(["-C", directory, "show", "-s", "--format=%B", commitSha]),
      this.#run(["-C", directory, "diff", "--name-only", "--no-ext-diff", parentSha, commitSha, "--"]),
      this.#run(
        ["-C", directory, "diff", "--no-ext-diff", "--unified=80", parentSha, commitSha, "--"],
        { maxBuffer: 32 * 1024 * 1024 },
      ),
    ]);
    return {
      parentSha,
      message: message.stdout,
      changedPaths: paths.stdout.split(/\r?\n/).filter(Boolean),
      diff: diff.stdout,
    };
  }

  async listFilesAtCommit({ directory, commitSha }) {
    const result = await this.#run(["-C", directory, "ls-tree", "-r", "--name-only", commitSha]);
    return result.stdout.split(/\r?\n/).filter(Boolean);
  }

  async readFileAtCommit({ directory, commitSha, path }) {
    const result = await this.#run(["-C", directory, "show", `${commitSha}:${path}`], {
      maxBuffer: 4 * 1024 * 1024,
    });
    return result.stdout;
  }

  #run(args, options = {}) {
    return this.#exec(this.#gitBinary, args, {
      ...options,
      ...(Object.keys(this.#env).length > 0 ? { env: { ...process.env, ...this.#env } } : {}),
    });
  }
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}
