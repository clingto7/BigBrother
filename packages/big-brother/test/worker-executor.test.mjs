import test from "node:test";
import assert from "node:assert/strict";
import { WorkerExecutor } from "../src/worker-executor.mjs";

const input = { protocol_version: "1", repository_id: "acme/app", commit_sha: "commit-3", parent_sha: "commit-2" };
const proposal = {
	repository_id: input.repository_id,
	commit_sha: input.commit_sha,
	parent_sha: input.parent_sha,
	observed_branches: [], conclusion: "clean", message_check: {}, findings: [], policy_checks: [],
	evidence: [], limitations: [], candidate_facts: [],
};

test("worker executor admits one identity-matched terminal response", async () => {
	const executor = new WorkerExecutor({
		command: process.execPath,
		args: ["-e", `let s='';process.stdin.on('data',c=>s+=c).on('end',()=>{const q=JSON.parse(s);process.stdout.write(JSON.stringify({type:'terminal',protocol_version:'1',job_id:q.job_id,attempt_id:q.attempt_id,repository_id:q.repository_id,commit_sha:q.commit_sha,input_digest:q.input_digest,result:${JSON.stringify(proposal)}})+'\\n')})`],
	});
	const result = await executor.runAttempt({ job: { repositoryId: input.repository_id, commitSha: input.commit_sha }, reviewInput: input });
	assert.equal(result.status, "success");
	assert.deepEqual(result.result, proposal);
	assert.match(result.attemptId, /^[0-9a-f-]{36}$/);
});

test("worker executor rejects malformed terminal protocol and abnormal exit explicitly", async () => {
	const malformed = new WorkerExecutor({ command: process.execPath, args: ["-e", "process.stdin.resume().on('end',()=>process.stdout.write('not json\\n'))"] });
	assert.equal((await malformed.runAttempt({ job: { repositoryId: input.repository_id, commitSha: input.commit_sha }, reviewInput: input })).status, "protocol_failed");
	const crashed = new WorkerExecutor({ command: process.execPath, args: ["-e", "process.exit(9)"] });
	assert.equal((await crashed.runAttempt({ job: { repositoryId: input.repository_id, commitSha: input.commit_sha }, reviewInput: input })).status, "crashed");
});

test("worker executor terminates timed out attempts", async () => {
	const executor = new WorkerExecutor({ command: process.execPath, args: ["-e", "setInterval(()=>{},1000)"], timeoutMs: 30 });
	assert.equal((await executor.runAttempt({ job: { repositoryId: input.repository_id, commitSha: input.commit_sha }, reviewInput: input })).status, "timed_out");
});

test("worker executor records cancellation and rejects a terminal response from another attempt", async () => {
	const controller = new AbortController();
	const waiting = new WorkerExecutor({ command: process.execPath, args: ["-e", "setInterval(()=>{},1000)"] })
		.runAttempt({ job: { repositoryId: input.repository_id, commitSha: input.commit_sha }, reviewInput: input, signal: controller.signal });
	setTimeout(() => controller.abort(), 20);
	assert.equal((await waiting).status, "cancelled");
	const stale = new WorkerExecutor({
		command: process.execPath,
		args: ["-e", `let s='';process.stdin.on('data',c=>s+=c).on('end',()=>{const q=JSON.parse(s);process.stdout.write(JSON.stringify({type:'terminal',protocol_version:'1',job_id:q.job_id,attempt_id:'old-attempt',repository_id:q.repository_id,commit_sha:q.commit_sha,input_digest:q.input_digest,result:{}})+'\\n')})`],
	});
	assert.equal((await stale.runAttempt({ job: { repositoryId: input.repository_id, commitSha: input.commit_sha }, reviewInput: input })).status, "protocol_failed");
});

test("worker executor excludes configured GitHub credential keys with arbitrary names", async () => {
	const key = "WORKER_TEST_GITHUB_TOKEN";
	const oldValue = process.env[key];
	process.env[key] = "secret-value";
	try {
		const executor = new WorkerExecutor({
			command: process.execPath,
			args: ["-e", `let s='';process.stdin.on('data',c=>s+=c).on('end',()=>{const q=JSON.parse(s);const result={secret:Boolean(process.env.${key})};process.stdout.write(JSON.stringify({type:'terminal',protocol_version:'1',job_id:q.job_id,attempt_id:q.attempt_id,repository_id:q.repository_id,commit_sha:q.commit_sha,input_digest:q.input_digest,result})+'\\n')})`],
		});
		const outcome = await executor.runAttempt({
			job: { repositoryId: input.repository_id, commitSha: input.commit_sha },
			reviewInput: input,
			excludedEnvKeys: [key],
		});
		assert.equal(outcome.result.secret, false);
	} finally {
		if (oldValue === undefined) delete process.env[key];
		else process.env[key] = oldValue;
	}
});
