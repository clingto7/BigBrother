import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { access, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
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

test("worker executor rejects terminal responses with a mismatched input digest or protocol version", async () => {
	for (const [field, value] of [
		["input_digest", "wrong-digest"], ["protocol_version", "2"],
		["job_id", "other/repo:other-commit"], ["repository_id", "other/repo"], ["commit_sha", "other-commit"],
	]) {
		const executor = new WorkerExecutor({
			command: process.execPath,
			args: ["-e", `let s='';process.stdin.on('data',c=>s+=c).on('end',()=>{const q=JSON.parse(s);const r={type:'terminal',protocol_version:q.protocol_version,job_id:q.job_id,attempt_id:q.attempt_id,repository_id:q.repository_id,commit_sha:q.commit_sha,input_digest:q.input_digest,result:${JSON.stringify(proposal)}};r[${JSON.stringify(field)}]=${JSON.stringify(value)};process.stdout.write(JSON.stringify(r)+'\\n')})`],
		});
		const result = await executor.runAttempt({ job: { repositoryId: input.repository_id, commitSha: input.commit_sha }, reviewInput: input });
		assert.equal(result.status, "protocol_failed", `must reject ${field} mismatch`);
	}
});

test("worker executor starts fresh attempts with the same immutable input digest", async () => {
	const executor = new WorkerExecutor({
		command: process.execPath,
		args: ["-e", `let s='';process.stdin.on('data',c=>s+=c).on('end',()=>{const q=JSON.parse(s);process.stdout.write(JSON.stringify({type:'terminal',protocol_version:'1',job_id:q.job_id,attempt_id:q.attempt_id,repository_id:q.repository_id,commit_sha:q.commit_sha,input_digest:q.input_digest,result:${JSON.stringify(proposal)}})+'\\n')})`],
	});
	const job = { repositoryId: input.repository_id, commitSha: input.commit_sha };
	const first = await executor.runAttempt({ job, reviewInput: input });
	const retry = await executor.runAttempt({ job, reviewInput: input });
	assert.equal(first.status, "success");
	assert.equal(retry.status, "success");
	assert.notEqual(first.attemptId, retry.attemptId);
	assert.equal(first.inputDigest, retry.inputDigest);
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

test("worker executor forwards Prime provider credentials but filters unrelated secrets", async () => {
	const keys = { ZAI_API_KEY: "zai-test-secret", DEEPSEEK_API_KEY: "deepseek-test-secret", UNRELATED_SERVICE_API_KEY: "unrelated-test-secret" };
	const previous = Object.fromEntries(Object.keys(keys).map((key) => [key, process.env[key]]));
	Object.assign(process.env, keys);
	try {
		const executor = new WorkerExecutor({
			command: process.execPath,
			args: ["-e", `let s='';process.stdin.on('data',c=>s+=c).on('end',()=>{const q=JSON.parse(s);const result={zai:Boolean(process.env.ZAI_API_KEY),deepseek:Boolean(process.env.DEEPSEEK_API_KEY),unrelated:Boolean(process.env.UNRELATED_SERVICE_API_KEY)};process.stdout.write(JSON.stringify({type:'terminal',protocol_version:'1',job_id:q.job_id,attempt_id:q.attempt_id,repository_id:q.repository_id,commit_sha:q.commit_sha,input_digest:q.input_digest,result})+'\\n')})`],
		});
		const outcome = await executor.runAttempt({ job: { repositoryId: input.repository_id, commitSha: input.commit_sha }, reviewInput: input });
		assert.deepEqual(outcome.result, { zai: true, deepseek: true, unrelated: false });
	} finally {
		for (const [key, value] of Object.entries(previous)) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
	}
});

test("worker executor terminates descendants when an attempt times out", { skip: process.platform === "win32" }, async () => {
	const directory = await mkdtemp(join(tmpdir(), "big-brother-worker-tree-"));
	const marker = join(directory, "descendant-survived");
	try {
		const script = `const {spawn}=require('node:child_process');const {writeFileSync}=require('node:fs');spawn(process.execPath,['-e',${JSON.stringify(`setTimeout(()=>require('node:fs').writeFileSync(${JSON.stringify(marker)},'alive'),450)`) }],{stdio:'ignore'});setInterval(()=>{},1000)`;
		const executor = new WorkerExecutor({ command: process.execPath, args: ["-e", script], timeoutMs: 60 });
		const result = await executor.runAttempt({ job: { repositoryId: input.repository_id, commitSha: input.commit_sha }, reviewInput: input });
		assert.equal(result.status, "timed_out");
		await new Promise((resolve) => setTimeout(resolve, 550));
		await assert.rejects(access(marker));
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test("worker executor removes its temporary directory for every terminal outcome", async () => {
	const validResponse = `let s='';process.stdin.on('data',c=>s+=c).on('end',()=>{const q=JSON.parse(s);process.stdout.write(JSON.stringify({type:'terminal',protocol_version:'1',job_id:q.job_id,attempt_id:q.attempt_id,repository_id:q.repository_id,commit_sha:q.commit_sha,input_digest:q.input_digest,result:${JSON.stringify(proposal)}})+'\\n')})`;
	const cases = [
		{ status: "success", args: ["-e", validResponse] },
		{ status: "crashed", args: ["-e", "process.exit(9)"] },
		{ status: "protocol_failed", args: ["-e", "process.stdin.resume().on('end',()=>process.stdout.write('bad\\n'))"] },
		{ status: "timed_out", args: ["-e", "setInterval(()=>{},1000)"], timeoutMs: 40 },
		{ status: "cancelled", args: ["-e", "setInterval(()=>{},1000)"], cancelAfterMs: 20 },
		{ status: "protocol_failed", args: ["-e", "process.stdout.write('x'.repeat(1024))"], maxOutputBytes: 64 },
	];
	for (const { status, args, timeoutMs, cancelAfterMs, maxOutputBytes } of cases) {
		let childCwd;
		const controller = new AbortController();
		const executor = new WorkerExecutor({
			command: process.execPath,
			args,
			timeoutMs,
			maxOutputBytes,
			spawnImpl(command, childArgs, options) {
				childCwd = options.cwd;
				return spawn(command, childArgs, options);
			},
		});
		const attempt = executor.runAttempt({ job: { repositoryId: input.repository_id, commitSha: input.commit_sha }, reviewInput: input, signal: controller.signal });
		if (cancelAfterMs) setTimeout(() => controller.abort(), cancelAfterMs);
		assert.equal((await attempt).status, status);
		await assert.rejects(access(childCwd), `temporary directory must be removed after ${status}`);
	}
});
