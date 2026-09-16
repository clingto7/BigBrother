import test from "node:test";
import assert from "node:assert/strict";

import { PrimeRuntimeSupervisor } from "../src/index.mjs";

test("supervisor keeps one long-lived Prime runtime per repository", async () => {
  const starts = [];
  const runtime = {
    async submitReview(input) {
      return { commitSha: input.commitSha };
    },
    async recover() {
      return { status: "ready" };
    },
    async stop() {},
  };
  const factory = {
    async start(profile, stateNamespace) {
      starts.push({ profile, stateNamespace });
      return runtime;
    },
  };
  const supervisor = new PrimeRuntimeSupervisor({ runtimeFactory: factory });
  const profile = { repositoryId: "acme/app", cwd: "/workspaces/acme-app" };

  const first = await supervisor.start(profile, "/data/acme-app");
  const second = await supervisor.start(profile, "/data/acme-app");

  assert.equal(first, second);
  assert.deepEqual(starts, [{ profile, stateNamespace: "/data/acme-app" }]);
  assert.deepEqual(await supervisor.submitReview(first, { commitSha: "commit-3" }), { commitSha: "commit-3" });
  assert.deepEqual(await supervisor.recover(first), { status: "ready" });
  await supervisor.stop(first);
});

test("supervisor serializes review submissions for one repository", async () => {
  const events = [];
  let releaseFirst;
  const firstFinished = new Promise((resolve) => {
    releaseFirst = resolve;
  });
  const runtime = {
    async submitReview(input) {
      events.push(`start:${input.commitSha}`);
      if (input.commitSha === "commit-1") await firstFinished;
      events.push(`finish:${input.commitSha}`);
      return input.commitSha;
    },
    async stop() {},
  };
  const supervisor = new PrimeRuntimeSupervisor({
    runtimeFactory: { async start() { return runtime; } },
  });
  const handle = await supervisor.start({ repositoryId: "acme/app" }, "/data/acme-app");

  const first = supervisor.submitReview(handle, { commitSha: "commit-1" });
  const second = supervisor.submitReview(handle, { commitSha: "commit-2" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(events, ["start:commit-1"]);

  releaseFirst();
  assert.deepEqual(await Promise.all([first, second]), ["commit-1", "commit-2"]);
  assert.deepEqual(events, ["start:commit-1", "finish:commit-1", "start:commit-2", "finish:commit-2"]);
  await supervisor.stop(handle);
});
