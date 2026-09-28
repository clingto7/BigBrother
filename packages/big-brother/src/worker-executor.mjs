import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const PROTOCOL_VERSION = "1";
const DEFAULT_CHILD = fileURLToPath(new URL("./worker-child.mjs", import.meta.url));

export class WorkerExecutor {
	#command;
	#args;
	#timeoutMs;
	#maxOutputBytes;
	#spawn;

	constructor({ command = process.execPath, args = [DEFAULT_CHILD], timeoutMs = 120_000, maxOutputBytes = 4 * 1024 * 1024, spawnImpl = spawn } = {}) {
		this.#command = command;
		this.#args = args;
		this.#timeoutMs = timeoutMs;
		this.#maxOutputBytes = maxOutputBytes;
		this.#spawn = spawnImpl;
	}

	async runAttempt({ job, reviewInput, signal, excludedEnvKeys = [] }) {
		const attemptId = randomUUID();
		const jobId = `${job.repositoryId}:${job.commitSha}`;
		const inputDigest = digest(reviewInput);
		let directory;
		let child;
		try {
			directory = await mkdtemp(join(tmpdir(), "big-brother-worker-"));
			if (signal?.aborted) return failure("cancelled", attemptId, "worker attempt cancelled");
			const request = {
				type: "request", protocol_version: PROTOCOL_VERSION, job_id: jobId, attempt_id: attemptId,
				repository_id: job.repositoryId, commit_sha: job.commitSha, input_digest: inputDigest, review_input: reviewInput,
			};
			const outcome = await new Promise((resolveOutcome) => {
				let stdout = Buffer.alloc(0);
				let stderr = "";
				let settled = false;
				let timedOut = false;
				let cancelled = false;
				let oversized = false;
				let killTimer;
				const finish = (result) => {
					if (settled) return;
					settled = true;
					clearTimeout(timer);
					clearTimeout(killTimer);
					signal?.removeEventListener("abort", onAbort);
					resolveOutcome(result);
				};
				const terminate = () => {
					child?.kill("SIGTERM");
					killTimer = setTimeout(() => child?.kill("SIGKILL"), 1_500);
				};
				const onAbort = () => { cancelled = true; terminate(); };
				child = this.#spawn(this.#command, this.#args, {
					cwd: directory,
					env: workerEnvironment(process.env, excludedEnvKeys),
					stdio: ["pipe", "pipe", "pipe"],
				});
				const timer = setTimeout(() => { timedOut = true; terminate(); }, this.#timeoutMs);
				signal?.addEventListener("abort", onAbort, { once: true });
				child.once("error", (error) => finish(failure("crashed", attemptId, error.message)));
				child.stdout.on("data", (chunk) => {
					stdout = Buffer.concat([stdout, chunk]);
					if (stdout.length > this.#maxOutputBytes) {
						oversized = true;
						terminate();
					}
				});
				child.stderr.on("data", (chunk) => { stderr = (stderr + chunk.toString()).slice(-8192); });
				child.once("close", (code, childSignal) => {
					if (timedOut) return finish(failure("timed_out", attemptId, "worker timed out"));
					if (cancelled) return finish(failure("cancelled", attemptId, "worker attempt cancelled"));
					if (oversized) return finish(failure("protocol_failed", attemptId, "worker output exceeded size limit"));
					if (code !== 0) return finish(failure("crashed", attemptId, `worker exited (${code ?? childSignal ?? "unknown"})${stderr ? `: ${stderr.trim()}` : ""}`));
					try {
						const lines = stdout.toString("utf8").split(/\r?\n/).filter(Boolean);
						if (lines.length !== 1) throw new Error("worker must return exactly one terminal JSONL response");
						const response = JSON.parse(lines[0]);
						for (const [key, expected] of Object.entries({ type: "terminal", protocol_version: PROTOCOL_VERSION, job_id: jobId, attempt_id: attemptId, repository_id: job.repositoryId, commit_sha: job.commitSha, input_digest: inputDigest })) {
							if (response?.[key] !== expected) throw new Error(`worker response ${key} mismatch`);
						}
						if (!response.result || typeof response.result !== "object" || Array.isArray(response.result)) throw new Error("worker terminal response has no result object");
						finish({ status: "success", attemptId, jobId, inputDigest, protocolVersion: PROTOCOL_VERSION, result: response.result });
					} catch (error) { finish(failure("protocol_failed", attemptId, error.message)); }
				});
				child.stdin.end(`${JSON.stringify(request)}\n`);
			});
			return outcome;
		} catch (error) {
			return failure("crashed", attemptId, error.message);
		} finally {
			if (child && child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
			if (directory) {
				try { await rm(directory, { recursive: true, force: true }); }
				catch (error) {
					// Cleanup must remain visible to the caller even when the attempt failed.
					if (typeof process.emitWarning === "function") process.emitWarning(`worker cleanup failed (${directory}): ${error.message}`);
				}
			}
		}
	}
}

function workerEnvironment(source, excludedEnvKeys = []) {
	const excluded = new Set(excludedEnvKeys);
	return Object.fromEntries(Object.entries(source).filter(([key]) =>
		!excluded.has(key) && !/(?:GITHUB|^GH_(?:TOKEN|ENTERPRISE_TOKEN)$|BIG_BROTHER_(?:CODING_AGENT_DIR|STATUS|PUBLICATION|READ)_TOKEN)/i.test(key),
	));
}

function digest(value) {
	return createHash("sha256").update(stableStringify(value)).digest("hex");
}

function stableStringify(value) {
	if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
	if (value && typeof value === "object") return `{${Object.keys(value).filter((key) => value[key] !== undefined).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(",")}}`;
	return JSON.stringify(value) ?? "null";
}

function failure(status, attemptId, message) {
	return { status, attemptId, error: message };
}
