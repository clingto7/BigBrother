import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PrimeRpcRuntimeFactory } from "./prime-rpc-runtime.mjs";

const lines = await readOneRequest();
const request = JSON.parse(lines[0]);
if (lines.length !== 1 || request?.type !== "request" || request.protocol_version !== "1") {
	throw new Error("invalid worker request protocol");
}
const scratch = await mkdtemp(join(tmpdir(), "big-brother-worker-runtime-"));
let runtime;
try {
	runtime = await new PrimeRpcRuntimeFactory().start({ repositoryId: request.repository_id, cwd: scratch }, join(scratch, "state"));
	const result = await runtime.submitWorkerReview(request.review_input);
	process.stdout.write(`${JSON.stringify({
		type: "terminal",
		protocol_version: request.protocol_version,
		job_id: request.job_id,
		attempt_id: request.attempt_id,
		repository_id: request.repository_id,
		commit_sha: request.commit_sha,
		input_digest: request.input_digest,
		result,
	})}\n`);
} catch (error) {
	process.stderr.write(`${error.message}\n`);
	process.exitCode = 1;
} finally {
	await runtime?.stop();
	await rm(scratch, { recursive: true, force: true });
}

async function readOneRequest() {
	let input = "";
	for await (const chunk of process.stdin) input += chunk;
	return input.split(/\r?\n/).filter(Boolean);
}
