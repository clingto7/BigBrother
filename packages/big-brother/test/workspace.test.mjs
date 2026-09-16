import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { GitCliAdapter, WorkspaceManager } from "../src/index.mjs";

test("workspace manager materializes and verifies the requested commit", async () => {
  const rootDir = mkdtempSync(join(tmpdir(), "big-brother-workspace-"));
  const calls = [];
  const git = {
    async ensureRepository(input) {
      calls.push(["ensure", input]);
    },
    async fetchCommit(input) {
      calls.push(["fetch", input]);
    },
    async checkoutDetached(input) {
      calls.push(["checkout", input]);
    },
    async revParse(input) {
      calls.push(["rev-parse", input]);
      return "commit-3";
    },
  };

  try {
    const workspace = await new WorkspaceManager({ rootDir, git }).materialize({
      repositoryId: "acme/app",
      cloneUrl: "https://github.com/acme/app.git",
      commitSha: "commit-3",
    });

    assert.equal(workspace.commitSha, "commit-3");
    assert.equal(workspace.directory.startsWith(rootDir), true);
    assert.deepEqual(calls.map(([operation]) => operation), ["ensure", "fetch", "checkout", "rev-parse"]);
    assert.deepEqual(calls[1][1], { directory: workspace.directory, commitSha: "commit-3" });
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("workspace manager refuses a checkout that resolves to another commit", async () => {
  const rootDir = mkdtempSync(join(tmpdir(), "big-brother-workspace-"));
  const git = {
    async ensureRepository() {},
    async fetchCommit() {},
    async checkoutDetached() {},
    async revParse() {
      return "wrong-commit";
    },
  };

  try {
    await assert.rejects(
      new WorkspaceManager({ rootDir, git }).materialize({
        repositoryId: "acme/app",
        cloneUrl: "https://github.com/acme/app.git",
        commitSha: "commit-3",
      }),
      /workspace commit mismatch/,
    );
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("Git CLI adapter uses argument arrays and never a shell command", async () => {
  const rootDir = mkdtempSync(join(tmpdir(), "big-brother-workspace-"));
  const calls = [];
  const git = new GitCliAdapter({
    execFile: async (...args) => {
      calls.push(args);
      return { stdout: "commit-3\n" };
    },
  });

  try {
    await git.ensureRepository({ directory: join(rootDir, "repo"), cloneUrl: "https://github.com/acme/app.git" });
    await git.fetchCommit({ directory: join(rootDir, "repo"), commitSha: "commit-3" });
    await git.checkoutDetached({ directory: join(rootDir, "repo"), commitSha: "commit-3" });
    assert.equal(await git.revParse({ directory: join(rootDir, "repo") }), "commit-3");
    assert.deepEqual(
      calls.map(([binary, args]) => [binary, args]),
      [
        ["git", ["clone", "--no-tags", "--no-checkout", "--", "https://github.com/acme/app.git", join(rootDir, "repo")]],
        ["git", ["-C", join(rootDir, "repo"), "fetch", "--no-tags", "origin", "commit-3"]],
        ["git", ["-C", join(rootDir, "repo"), "checkout", "--detach", "--force", "commit-3"]],
        ["git", ["-C", join(rootDir, "repo"), "rev-parse", "HEAD"]],
      ],
    );
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("Git CLI adapter can use an explicitly configured SSH key", async () => {
  let options;
  const git = new GitCliAdapter({
    sshKeyPath: "/private/keys/reviewer's key",
    execFile: async (...args) => {
      options = args[2];
      return { stdout: "commit-3\n" };
    },
  });

  await git.revParse({ directory: "/work/repo" });
  assert.match(options.env.GIT_SSH_COMMAND, /ssh -i/);
  assert.match(options.env.GIT_SSH_COMMAND, /reviewer/);
  assert.match(options.env.GIT_SSH_COMMAND, /IdentitiesOnly=yes/);
});
