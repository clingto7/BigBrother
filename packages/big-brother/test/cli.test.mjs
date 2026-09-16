import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { buildInteractivePrimeLaunchOptions, loadEnvFile, parseControlArgs, runCli, runWatch } from "../src/index.mjs";

test("control CLI parses config, review, and watch options", () => {
  assert.deepEqual(parseControlArgs(["agent"]), {
    command: "agent",
    options: { configPath: process.cwd() + "/config/big-brother.json", once: false },
  });
  assert.deepEqual(parseControlArgs(["config", "validate", "--config", "config/test.json"]), {
    command: "config",
    options: { configPath: process.cwd() + "/config/test.json", once: false },
  });
  assert.deepEqual(parseControlArgs(["review", "--repo", "acme/app", "--commit", "commit-2", "--config", "state.json"]), {
    command: "review",
    options: {
      configPath: process.cwd() + "/state.json",
      once: false,
      repositoryId: "acme/app",
      commitSha: "commit-2",
    },
  });
  assert.deepEqual(parseControlArgs(["watch", "--once", "--interval-ms", "1000"]), {
    command: "watch",
    options: { configPath: process.cwd() + "/config/big-brother.json", once: true, intervalMs: 1000 },
  });
  assert.deepEqual(parseControlArgs([
    "service", "render", "launchd",
    "--config", "/srv/big-brother/config.json",
    "--executable", "/srv/big-brother/bin/big-brother",
    "--working-directory", "/srv/big-brother",
    "--env-file", "/etc/big-brother/env",
    "--restart-seconds", "20",
  ]), {
    command: "service",
    options: {
      configPath: "/srv/big-brother/config.json",
      once: false,
      serviceAction: "render",
      servicePlatform: "launchd",
      executablePath: "/srv/big-brother/bin/big-brother",
      workingDirectory: "/srv/big-brother",
      envFile: "/etc/big-brother/env",
      restartSeconds: 20,
    },
  });
});

test("interactive agent launch keeps login state outside repository sessions", () => {
  const launch = buildInteractivePrimeLaunchOptions({
    cliPath: "/opt/big-brother/prime.js",
    cwd: "/work/big-brother",
    agentDir: "/var/lib/big-brother/agent",
    reviewerProfile: { runtimeArgs: ["--no-context-files", "--no-tools"] },
    resources: { systemPrompt: "Big Brother prompt", skillPaths: ["/opt/commit-review"] },
  });
  assert.equal(launch.cliPath, "/opt/big-brother/prime.js");
  assert.equal(launch.cwd, "/work/big-brother");
  assert.deepEqual(launch.args, [
    "--system-prompt", "Big Brother prompt", "--skill", "/opt/commit-review",
    "--no-context-files", "--no-tools",
  ]);
  assert.equal(launch.env.BIG_BROTHER_CODING_AGENT_DIR, "/var/lib/big-brother/agent");
});

test("control CLI validates an example configuration without starting Prime", async () => {
  const output = [];
  const code = await runCli(["config", "validate", "--config", "../../config/big-brother.example.json"], {
    stdout: (line) => output.push(line),
  });
  assert.equal(code, 0);
  assert.match(output[0], /configuration valid/);
});

test("service render command prints a platform service definition without starting watch", async () => {
  const output = [];
  const code = await runCli([
    "service", "render", "systemd",
    "--config", "/srv/big-brother/config.json",
    "--executable", "/srv/big-brother/bin/big-brother",
    "--working-directory", "/srv/big-brother",
    "--env-file", "/etc/big-brother/env",
  ], { stdout: (line) => output.push(line) });

  assert.equal(code, 0);
  assert.match(output[0], /ExecStart=.*watch.*--config/);
  assert.match(output[0], /Restart=on-failure/);
});

test("env file loads simple exports without executing shell code", async () => {
  const directory = await mkdtemp(join(tmpdir(), "big-brother-env-"));
  const filePath = join(directory, "env");
  await writeFile(filePath, [
    "# comment",
    "export GITHUB_TOKEN='from-file'",
    'NODE_USE_ENV_PROXY=1',
    'PROXY_URL="http://127.0.0.1:7897"',
    'IGNORED=$(touch should-not-exist)',
  ].join("\n"));
  const targetEnv = { GITHUB_TOKEN: "from-process" };

  try {
    const result = await loadEnvFile(filePath, { targetEnv });
    assert.deepEqual(result, { loaded: true, variables: 4 });
    assert.equal(targetEnv.GITHUB_TOKEN, "from-process");
    assert.equal(targetEnv.NODE_USE_ENV_PROXY, "1");
    assert.equal(targetEnv.PROXY_URL, "http://127.0.0.1:7897");
    assert.equal(targetEnv.IGNORED, "$(touch should-not-exist)");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("watch stops promptly when interrupted during the polling interval", async () => {
  let closed = false;
  const service = {
    profile: { repositoryId: "acme/app", trackedBranches: ["main"] },
    store: {
      getBranch: () => ({ cursorSha: "same" }),
      listReviewJobs: () => [],
    },
    readGithub: {
      async getBranchHead() { return { sha: "same" }; },
    },
    async close() { closed = true; },
  };
  const started = performance.now();
  const stopTimer = setTimeout(() => process.emit("SIGINT"), 10);

  try {
    await runWatch(
      { repositories: [service.profile], pollIntervalMs: 1_000 },
      { once: false, intervalMs: 1_000 },
      { servicesFactory: () => service, stdout: () => {}, stderr: () => {} },
    );
  } finally {
    clearTimeout(stopTimer);
  }

  assert.equal(closed, true);
  assert.ok(performance.now() - started < 500, "watch should not wait for the full polling interval after SIGINT");
});
