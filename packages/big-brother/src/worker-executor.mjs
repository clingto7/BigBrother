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
		let outcome;
		try {
			directory = await mkdtemp(join(tmpdir(), "big-brother-worker-"));
			if (signal?.aborted) {
				outcome = failure("cancelled", attemptId, "worker attempt cancelled");
			} else {
				const request = {
					type: "request", protocol_version: PROTOCOL_VERSION, job_id: jobId, attempt_id: attemptId,
					repository_id: job.repositoryId, commit_sha: job.commitSha, input_digest: inputDigest, review_input: reviewInput,
				};
				// Timeout, cancellation, output overflow, process exit, and protocol errors
				// race; the first terminal event observed determines this attempt's outcome.
				outcome = await new Promise((resolveOutcome) => {
					let stdout = Buffer.alloc(0);
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
						signalProcessTree(child, "SIGTERM");
						killTimer = setTimeout(() => signalProcessTree(child, "SIGKILL"), 1_500);
					};
					const onAbort = () => { cancelled = true; terminate(); };
					child = this.#spawn(this.#command, this.#args, {
						cwd: directory,
						env: workerEnvironment(process.env, excludedEnvKeys),
						detached: process.platform !== "win32",
						stdio: ["pipe", "pipe", "pipe"],
					});
					const timer = setTimeout(() => { timedOut = true; terminate(); }, this.#timeoutMs);
					signal?.addEventListener("abort", onAbort, { once: true });
					child.once("error", (error) => finish(failure("crashed", attemptId, errorMessage(error))));
					child.stdout.on("data", (chunk) => {
						stdout = Buffer.concat([stdout, chunk]);
						if (stdout.length > this.#maxOutputBytes) {
							oversized = true;
							terminate();
						}
					});
					// Drain diagnostics without persisting them; provider errors can contain secrets.
					child.stderr.on("data", () => {});
					// A child that exits before consuming its request can close stdin early.
					// The child's close event below is the authoritative attempt outcome.
					child.stdin.on("error", () => {});
					child.once("close", (code, childSignal) => {
						if (timedOut) return finish(failure("timed_out", attemptId, "worker timed out"));
						if (cancelled) return finish(failure("cancelled", attemptId, "worker attempt cancelled"));
						if (oversized) return finish(failure("protocol_failed", attemptId, "worker output exceeded size limit"));
						if (code !== 0) return finish(failure("crashed", attemptId, `worker exited (${code ?? childSignal ?? "unknown"})`));
						try {
							const lines = stdout.toString("utf8").split(/\r?\n/).filter(Boolean);
							if (lines.length !== 1) throw new Error("worker must return exactly one terminal JSONL response");
							const response = JSON.parse(lines[0]);
							for (const [key, expected] of Object.entries({ type: "terminal", protocol_version: PROTOCOL_VERSION, job_id: jobId, attempt_id: attemptId, repository_id: job.repositoryId, commit_sha: job.commitSha, input_digest: inputDigest })) {
								if (response?.[key] !== expected) throw new Error(`worker response ${key} mismatch`);
							}
							if (!response.result || typeof response.result !== "object" || Array.isArray(response.result)) throw new Error("worker terminal response has no result object");
							finish({ status: "success", attemptId, jobId, inputDigest, protocolVersion: PROTOCOL_VERSION, result: response.result });
						} catch (error) { finish(failure("protocol_failed", attemptId, errorMessage(error))); }
					});
					child.stdin.end(`${JSON.stringify(request)}\n`);
				});
			}
		} catch (error) {
			outcome = failure("crashed", attemptId, errorMessage(error));
		} finally {
			if (child) {
				try {
					await terminateProcessTree(child);
				} catch (error) {
					outcome = cleanupFailure(outcome, attemptId, `worker process cleanup failed: ${errorMessage(error)}`);
				}
			}
			if (directory) {
				try {
					await rm(directory, { recursive: true, force: true });
				} catch (error) {
					outcome = cleanupFailure(outcome, attemptId, `worker temporary-resource cleanup failed: ${errorMessage(error)}`);
				}
			}
		}
		return { ...outcome, inputDigest, jobId, protocolVersion: PROTOCOL_VERSION };
	}
}

function workerEnvironment(source, excludedEnvKeys = []) {
	const excluded = new Set(excludedEnvKeys);
	const allowedKeys = new Set([
		"PATH", "HOME", "USERPROFILE", "TMPDIR", "TMP", "TEMP", "LANG", "LC_ALL", "SYSTEMROOT",
		"SSL_CERT_FILE", "SSL_CERT_DIR", "NODE_EXTRA_CA_CERTS", "BIG_BROTHER_CODING_AGENT_DIR",
		// Prime-supported provider credentials. Keep this explicit: forwarding every
		// *_API_KEY variable would expose unrelated parent-process secrets.
		"ANTHROPIC_OAUTH_TOKEN", "ANTHROPIC_API_KEY", "OPENAI_API_KEY", "AZURE_OPENAI_API_KEY",
		"PRIME_API_KEY", "DEEPSEEK_API_KEY", "GEMINI_API_KEY", "GOOGLE_CLOUD_API_KEY",
		"GROQ_API_KEY", "CEREBRAS_API_KEY", "XAI_API_KEY", "OPENROUTER_API_KEY",
		"AI_GATEWAY_API_KEY", "ZAI_API_KEY", "MISTRAL_API_KEY", "MINIMAX_API_KEY",
		"MINIMAX_CN_API_KEY", "MOONSHOT_API_KEY", "HF_TOKEN", "FIREWORKS_API_KEY",
		"OPENCODE_API_KEY", "KIMI_API_KEY", "CLOUDFLARE_API_KEY", "XIAOMI_API_KEY",
		"XIAOMI_TOKEN_PLAN_CN_API_KEY", "XIAOMI_TOKEN_PLAN_AMS_API_KEY", "XIAOMI_TOKEN_PLAN_SGP_API_KEY",
		"GOOGLE_APPLICATION_CREDENTIALS", "GOOGLE_CLOUD_PROJECT", "GCLOUD_PROJECT", "GOOGLE_CLOUD_LOCATION",
		"AWS_PROFILE", "AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_SESSION_TOKEN",
		"AWS_BEARER_TOKEN_BEDROCK", "AWS_CONTAINER_CREDENTIALS_RELATIVE_URI", "AWS_CONTAINER_CREDENTIALS_FULL_URI",
		"AWS_WEB_IDENTITY_TOKEN_FILE", "AWS_REGION", "AWS_DEFAULT_REGION",
	]);
	return Object.fromEntries(Object.entries(source).filter(([key]) =>
		!excluded.has(key) && (allowedKeys.has(key) || /^LC_[A-Z0-9_]+$/.test(key)),
	));
}

function signalProcessTree(child, signal) {
	if (!child?.pid) return;
	if (process.platform === "win32") {
		child.kill(signal);
		return;
	}
	try {
		process.kill(-child.pid, signal);
	} catch (error) {
		if (error.code !== "ESRCH") throw error;
	}
}

async function terminateProcessTree(child) {
	if (process.platform === "win32" || !child.pid) {
		if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
		return;
	}
	try {
		process.kill(-child.pid, "SIGTERM");
	} catch (error) {
		if (error.code === "ESRCH") return;
		throw error;
	}
	await new Promise((resolveDelay) => setTimeout(resolveDelay, 50));
	try {
		process.kill(-child.pid, "SIGKILL");
	} catch (error) {
		if (error.code !== "ESRCH") throw error;
	}
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

function cleanupFailure(outcome, attemptId, message) {
	return {
		...(outcome ?? failure("crashed", attemptId, "worker outcome was unavailable")),
		status: "cleanup_failed",
		error: [outcome?.error, message].filter(Boolean).join("; "),
	};
}

function errorMessage(error) {
	return error instanceof Error ? error.message : String(error);
}
