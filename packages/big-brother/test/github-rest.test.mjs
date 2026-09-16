import test from "node:test";
import assert from "node:assert/strict";

import { GitHubRestAdapter } from "../src/index.mjs";

function response(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() {
      return body;
    },
  };
}

test("GitHub REST adapter reads a branch head with an authorization header", async () => {
  const calls = [];
  const github = new GitHubRestAdapter({
    token: "test-token",
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return response({ object: { sha: "commit-3" } });
    },
  });

  const head = await github.getBranchHead({ repositoryId: "acme/app", branchName: "feature/login" });

  assert.deepEqual(head, { sha: "commit-3" });
  assert.equal(calls[0].url, "https://api.github.com/repos/acme/app/git/ref/heads/feature%2Flogin");
  assert.equal(calls[0].options.headers.authorization, "Bearer test-token");
});

test("GitHub REST adapter returns compare commits in page order", async () => {
  const urls = [];
  const github = new GitHubRestAdapter({
    token: "test-token",
    pageSize: 2,
    fetchImpl: async (url) => {
      urls.push(url);
      const page = new URL(url).searchParams.get("page");
      return page === "1"
        ? response({ commits: [{ sha: "commit-2" }, { sha: "commit-3" }] })
        : response({ commits: [{ sha: "commit-4" }] });
    },
  });

  const commits = await github.listCommits({
    repositoryId: "acme/app",
    branchName: "main",
    fromSha: "commit-1",
    toSha: "commit-4",
  });

  assert.deepEqual(commits, [{ sha: "commit-2" }, { sha: "commit-3" }, { sha: "commit-4" }]);
  assert.equal(urls.length, 2);
  assert.match(urls[0], /compare\/commit-1\.\.\.commit-4\?/);
  assert.match(urls[1], /page=2/);
});

test("GitHub REST adapter preserves API failures", async () => {
  const github = new GitHubRestAdapter({
    token: "test-token",
    fetchImpl: async () => response({ message: "Not Found" }, 404),
  });

  await assert.rejects(
    github.getBranchHead({ repositoryId: "acme/app", branchName: "missing" }),
    /GitHub API request failed \(404\)/,
  );
});

test("GitHub REST adapter creates a completed check run", async () => {
  const calls = [];
  const github = new GitHubRestAdapter({
    token: "checks-token",
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return response({ id: 42, html_url: "https://github.com/acme/app/runs/42" }, 201);
    },
  });

  const checkRun = await github.createCheckRun({
    repositoryId: "acme/app",
    name: "Big Brother",
    headSha: "commit-3",
    conclusion: "neutral",
    output: { title: "Review complete", summary: "No blocking findings." },
  });

  assert.deepEqual(checkRun, { id: 42, html_url: "https://github.com/acme/app/runs/42" });
  assert.equal(calls[0].url, "https://api.github.com/repos/acme/app/check-runs");
  assert.equal(calls[0].options.method, "POST");
  assert.deepEqual(JSON.parse(calls[0].options.body), {
    name: "Big Brother",
    head_sha: "commit-3",
    status: "completed",
    conclusion: "neutral",
    output: { title: "Review complete", summary: "No blocking findings." },
  });
});

test("GitHub REST adapter updates an existing check run", async () => {
  const calls = [];
  const github = new GitHubRestAdapter({
    token: "checks-token",
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return response({ id: 42, conclusion: "success" });
    },
  });

  await github.updateCheckRun({
    repositoryId: "acme/app",
    checkRunId: 42,
    conclusion: "success",
    output: { title: "Review complete", summary: "No findings." },
  });

  assert.equal(calls[0].url, "https://api.github.com/repos/acme/app/check-runs/42");
  assert.equal(calls[0].options.method, "PATCH");
  assert.deepEqual(JSON.parse(calls[0].options.body), {
    status: "completed",
    conclusion: "success",
    output: { title: "Review complete", summary: "No findings." },
  });
});

test("GitHub REST adapter creates a commit status", async () => {
  const calls = [];
  const github = new GitHubRestAdapter({
    token: "status-token",
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return response({ id: 7, state: "success", context: "big-brother/review" }, 201);
    },
  });

  const status = await github.createCommitStatus({
    repositoryId: "acme/app",
    commitSha: "commit-3",
    state: "success",
    context: "big-brother/review",
    description: "Big Brother: clean",
  });

  assert.deepEqual(status, { id: 7, state: "success", context: "big-brother/review" });
  assert.equal(calls[0].url, "https://api.github.com/repos/acme/app/statuses/commit-3");
  assert.equal(calls[0].options.method, "POST");
  assert.deepEqual(JSON.parse(calls[0].options.body), {
    state: "success",
    context: "big-brother/review",
    description: "Big Brother: clean",
  });
});
