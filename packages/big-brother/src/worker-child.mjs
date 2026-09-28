import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { PrimeRpcRuntimeFactory } from "./prime-rpc-runtime.mjs";

let runtime;
let runtimePromise;
let terminateRequested = false;
process.once("SIGTERM", () => {
	terminateRequested = true;
	const stopRuntime = runtime ? Promise.resolve(runtime) : runtimePromise;
	if (stopRuntime) void stopRuntime.then((activeRuntime) => activeRuntime.stop()).catch(() => undefined).finally(() => { process.exitCode = 143; });
});
try {
	const lines = await readOneRequest();
	if (lines.length !== 1) throw new Error("worker must receive exactly one JSONL request");
	const request = JSON.parse(lines[0]);
	if (request?.type !== "request" || request.protocol_version !== "1") {
		throw new Error("invalid worker request protocol");
	}
	const scratch = join(process.cwd(), "runtime");
	await mkdir(scratch);
	runtimePromise = new PrimeRpcRuntimeFactory().start({ repositoryId: request.repository_id, cwd: scratch }, join(scratch, "state"));
	runtime = await runtimePromise;
	if (terminateRequested) {
		await runtime.stop();
		process.exitCode = 143;
	} else {
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
	}
} catch (error) {
	process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
	process.exitCode = 1;
} finally {
	await runtime?.stop();
}

async function readOneRequest() {
	let input = "";
	for await (const chunk of process.stdin) input += chunk;
	return input.split(/\r?\n/).filter(Boolean);
}
