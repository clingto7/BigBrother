import { spawn } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { join, resolve } from "node:path";
import { homedir } from "node:os";
import { readFile } from "node:fs/promises";

import { loadConfigurationFile } from "./configuration.mjs";
import { GitHubRestAdapter } from "./github-rest.mjs";
import { retryReviewFindingIssues } from "./finding-issue-publisher.mjs";
import { GitReviewEvidenceAdapter } from "./git-review-evidence.mjs";
import { GitCliAdapter, WorkspaceManager } from "./workspace.mjs";
import { PrimeRpcRuntimeFactory } from "./prime-rpc-runtime.mjs";
import { PrimeRuntimeSupervisor } from "./prime-runtime.mjs";
import { createReviewerProfile, loadReviewerResources } from "./reviewer-profile.mjs";
import { ReviewCoordinator } from "./review-coordinator.mjs";
import { renderLaunchdPlist, renderSystemdUnit } from "./service-manifests.mjs";
import { SqliteJobStore } from "./sqlite-job-store.mjs";
import { pollRepository } from "./poller.mjs";

const DEFAULT_CONFIG_PATH = resolve(process.env.BIG_BROTHER_CONFIG ?? "config/big-brother.json");
const DEFAULT_ENV_FILE = resolve(process.env.BIG_BROTHER_ENV_FILE ?? join(homedir(), ".config/big-brother/env"));
const DEFAULT_PRIME_CLI_PATH = fileURLToPath(new URL("../../../runtime/dist/bundle/cli.js", import.meta.url));
const COMPLETION_ROOT = new URL("../completions/", import.meta.url);

export function parseControlArgs(argv) {
	const [first, ...rest] = argv;
	const command = first === "--help" || first === "-h" || first === undefined ? "help" : first;
	const options = { configPath: DEFAULT_CONFIG_PATH, once: false };
	if (command === "service") {
		options.serviceAction = rest[0];
		options.servicePlatform = rest[1];
	}
	const optionArgs =
		(command === "config" && rest[0] === "validate") || (command === "completion" && rest[0])
			? rest.slice(1)
			: command === "service"
				? rest.slice(2)
			: rest;
	for (let index = 0; index < optionArgs.length; index += 1) {
		const arg = optionArgs[index];
		if (arg === "--help" || arg === "-h") return { command: "help", options };
		if (arg === "--config") {
			options.configPath = resolve(requireValue(optionArgs, ++index, "--config"));
		} else if (arg === "--repo") {
			options.repositoryId = requireValue(optionArgs, ++index, "--repo");
		} else if (arg === "--commit") {
			options.commitSha = requireValue(optionArgs, ++index, "--commit");
		} else if (arg === "--executable") {
			options.executablePath = resolve(requireValue(optionArgs, ++index, "--executable"));
		} else if (arg === "--working-directory") {
			options.workingDirectory = resolve(requireValue(optionArgs, ++index, "--working-directory"));
		} else if (arg === "--env-file") {
			options.envFile = resolve(requireValue(optionArgs, ++index, "--env-file"));
		} else if (arg === "--label") {
			options.label = requireValue(optionArgs, ++index, "--label");
		} else if (arg === "--restart-seconds") {
			options.restartSeconds = Number(requireValue(optionArgs, ++index, "--restart-seconds"));
			if (!Number.isInteger(options.restartSeconds) || options.restartSeconds < 1) throw new Error("--restart-seconds must be a positive integer");
		} else if (arg === "--once") {
			options.once = true;
		} else if (arg === "--interval-ms") {
			options.intervalMs = Number(requireValue(optionArgs, ++index, "--interval-ms"));
			if (!Number.isInteger(options.intervalMs) || options.intervalMs < 1_000) throw new Error("--interval-ms must be an integer >= 1000");
		} else if (arg !== undefined) {
			throw new Error(`unknown Big Brother option: ${arg}`);
		}
	}
	return { command, options };
}

export async function runCli(argv, { stdout = console.log, stderr = console.error } = {}) {
	await loadEnvFile();
	const { command, options } = parseControlArgs(argv);
	if (command === "help") {
		stdout(CLI_HELP);
		return 0;
	}
	if (command === "config") {
		if (argv[1] !== "validate") throw new Error("usage: big-brother config validate --config <path>");
		await loadConfigurationFile(options.configPath);
		stdout(`configuration valid: ${options.configPath}`);
		return 0;
	}
	if (command === "completion") {
		const shell = argv[1];
		if (!["bash", "zsh", "fish"].includes(shell)) throw new Error("usage: big-brother completion <bash|zsh|fish>");
		const completionFile = shell === "zsh" ? "_big-brother" : `big-brother.${shell}`;
		stdout(await readFile(new URL(completionFile, COMPLETION_ROOT), "utf8"));
		return 0;
	}
	if (command === "service") {
		if (options.serviceAction !== "render" || !["launchd", "systemd"].includes(options.servicePlatform)) {
			throw new Error("usage: big-brother service render <launchd|systemd> --config <path> --executable <path>");
		}
		const render = options.servicePlatform === "launchd" ? renderLaunchdPlist : renderSystemdUnit;
		stdout(render({
			label: options.label,
			executable: options.executablePath,
			configPath: options.configPath,
			workingDirectory: options.workingDirectory ?? process.cwd(),
			envFile: options.envFile ?? DEFAULT_ENV_FILE,
			restartSeconds: options.restartSeconds,
		}));
		return 0;
	}
	if (command === "agent") {
		return runAgent();
	}

	const configuration = await loadConfigurationFile(options.configPath);
	if (command === "review") {
		if (!options.repositoryId || !options.commitSha) throw new Error("usage: big-brother review --config <path> --repo <owner/name> --commit <sha>");
		await runOneShotReview(configuration, options, stdout, stderr);
		return 0;
	}
	if (command === "watch") {
		await runWatch(configuration, options, { stdout, stderr });
		return 0;
	}
	throw new Error(`unknown Big Brother command: ${command}`);
}

/**
 * Load the optional user-owned environment file without executing shell code.
 * Existing process variables take precedence over values from the file.
 */
export async function loadEnvFile(filePath = DEFAULT_ENV_FILE, { targetEnv = process.env } = {}) {
	let source;
	try {
		source = await readFile(filePath, "utf8");
	} catch (error) {
		if (error.code === "ENOENT") return { loaded: false, variables: 0 };
		throw new Error(`cannot read Big Brother env file ${filePath}: ${error.message}`);
	}

	let variables = 0;
	for (const line of source.split(/\r?\n/)) {
		const match = line.match(/^\s*(?:export\s+)?([A-Z][A-Z0-9_]*)\s*=\s*(.*?)\s*$/);
		if (!match || match[0].trimStart().startsWith("#")) continue;
		const [, name, rawValue] = match;
		const value = parseEnvValue(rawValue);
		if (targetEnv[name] === undefined) targetEnv[name] = value;
		variables += 1;
	}
	return { loaded: true, variables };
}

function parseEnvValue(rawValue) {
	if (rawValue.length >= 2) {
		const first = rawValue[0];
		const last = rawValue.at(-1);
		if ((first === "'" || first === '"') && last === first) {
			const value = rawValue.slice(1, -1);
			return first === '"' ? value.replace(/\\([\\"nrt$])/g, (_, character) => ({ n: "\n", r: "\r", t: "\t", $: "$", "\\": "\\", '"': '"' })[character] ?? character) : value;
		}
	}
	return rawValue;
}

/** Build the interactive Prime launch used for login and model selection. */
export function buildInteractivePrimeLaunchOptions({
	cliPath = DEFAULT_PRIME_CLI_PATH,
	cwd = process.cwd(),
	agentDir = process.env.BIG_BROTHER_CODING_AGENT_DIR ?? resolve(".big-brother/agent"),
	reviewerProfile,
	resources,
} = {}) {
	if (!resources?.systemPrompt) throw new Error("Big Brother agent requires reviewer resources");
	return Object.freeze({
		cliPath: resolve(cliPath),
		cwd: resolve(cwd),
		args: Object.freeze([
			"--system-prompt",
			resources.systemPrompt,
			...resources.skillPaths.flatMap((skillPath) => ["--skill", skillPath]),
			...reviewerProfile.runtimeArgs,
		]),
		env: Object.freeze({
			...process.env,
			BIG_BROTHER_CODING_AGENT_DIR: resolve(agentDir),
		}),
	});
}

export async function runAgent({
	spawnImpl = spawn,
	cliPath = DEFAULT_PRIME_CLI_PATH,
	cwd = process.cwd(),
	agentDir = process.env.BIG_BROTHER_CODING_AGENT_DIR ?? resolve(".big-brother/agent"),
	profile = createReviewerProfile(),
	resourceLoader = loadReviewerResources,
} = {}) {
	const resources = await resourceLoader(profile);
	const launch = buildInteractivePrimeLaunchOptions({ cliPath, cwd, agentDir, reviewerProfile: profile, resources });
	return new Promise((resolveExit, rejectExit) => {
		const child = spawnImpl("node", [launch.cliPath, ...launch.args], {
			cwd: launch.cwd,
			env: launch.env,
			stdio: "inherit",
		});
		child.once("error", rejectExit);
		child.once("exit", (code, signal) => resolveExit(code ?? (signal ? 1 : 0)));
	});
}

export async function runWatch(configuration, options, { stdout = console.log, stderr = console.error, servicesFactory = createRepositoryServices } = {}) {
	const services = configuration.repositories.map((repositoryProfile) => servicesFactory(repositoryProfile));
	let stopping = false;
	let resolveStop;
	const stopped = new Promise((resolveStopped) => {
		resolveStop = resolveStopped;
	});
	const stop = () => {
		if (stopping) return;
		stopping = true;
		resolveStop();
	};
	process.once("SIGINT", stop);
	process.once("SIGTERM", stop);
	try {
		do {
			for (const service of services) {
				try {
					const result = await runRepositoryCycle(service);
					stdout(`${service.profile.repositoryId}: discovered=${result.discovered} processed=${result.processed} failed=${result.failed}`);
					for (const failure of result.findingIssueFailures) {
						stderr(`${service.profile.repositoryId}: finding ${failure.findingId}: ${failure.lastError}`);
					}
				} catch (error) {
					stderr(`${service.profile.repositoryId}: cycle failed: ${error.message}`);
				}
			}
			if (!options.once && !stopping) {
				await Promise.race([delay(options.intervalMs ?? configuration.pollIntervalMs), stopped]);
			}
		} while (!options.once && !stopping);
	} finally {
		process.off("SIGINT", stop);
		process.off("SIGTERM", stop);
		await Promise.allSettled(services.map((service) => service.close()));
	}
}

async function runOneShotReview(configuration, options, stdout, stderr) {
	const profile = configuration.repositories.find((item) => item.repositoryId === options.repositoryId);
	if (!profile) throw new Error(`repository is not configured: ${options.repositoryId}`);
	const service = createRepositoryServices(profile);
	try {
		const branchName = profile.trackedBranches[0];
		const head = await service.readGithub.getBranchHead({ repositoryId: profile.repositoryId, branchName });
		service.store.enrollBranch({ repositoryId: profile.repositoryId, branchName, headSha: head.sha });
		const job = service.store.admitCommitReview({ repositoryId: profile.repositoryId, commitSha: options.commitSha, branchName }).job;
		service.store.setReviewJobStatus({ repositoryId: job.repositoryId, commitSha: job.commitSha, status: "reviewing" });
		try {
			const result = await processJob(service, job);
			service.store.setReviewJobStatus({ repositoryId: job.repositoryId, commitSha: job.commitSha, status: "completed" });
			stdout(`reviewed ${profile.repositoryId}@${options.commitSha}; status=big-brother/review`);
			for (const failure of result.findingIssues.filter((publication) => publication.status === "failed")) {
				stderr(`${profile.repositoryId}: finding ${failure.findingId}: ${failure.lastError}`);
			}
		} catch (error) {
			service.store.setReviewJobStatus({ repositoryId: job.repositoryId, commitSha: job.commitSha, status: "failed" });
			throw error;
		}
	} finally {
		await service.close();
	}
}

export async function runRepositoryCycle(service) {
	const retriedFindingIssues = await retryReviewFindingIssues({
		github: service.publishGithub,
		store: service.store,
		repositoryId: service.profile.repositoryId,
	});
	for (const branchName of service.profile.trackedBranches) {
		if (!service.store.getBranch({ repositoryId: service.profile.repositoryId, branchName })) {
			const head = await service.readGithub.getBranchHead({ repositoryId: service.profile.repositoryId, branchName });
			service.store.enrollBranch({ repositoryId: service.profile.repositoryId, branchName, headSha: head.sha });
		}
	}
	const pollResult = await pollRepository({
		repositoryId: service.profile.repositoryId,
		trackedBranches: service.profile.trackedBranches,
		github: service.readGithub,
		store: service.store,
	});
	let processed = 0;
	let failed = 0;
	for (const job of service.store.listReviewJobs(service.profile.repositoryId)) {
		if (job.status === "completed") continue;
		service.store.setReviewJobStatus({ repositoryId: job.repositoryId, commitSha: job.commitSha, status: "reviewing" });
		try {
			await processJob(service, job);
			service.store.setReviewJobStatus({ repositoryId: job.repositoryId, commitSha: job.commitSha, status: "completed" });
			processed += 1;
		} catch (error) {
			service.store.setReviewJobStatus({ repositoryId: job.repositoryId, commitSha: job.commitSha, status: "failed" });
			failed += 1;
		}
	}
	const findingIssueFailures = service.store.listRetryableFindingIssues(service.profile.repositoryId)
		.filter((publication) => publication.status === "failed")
		.map(({ findingId, lastError }) => ({ findingId, lastError }));
	return { ...pollResult, processed, failed, retriedFindingIssues, findingIssueFailures };
}

async function processJob(service, job) {
	return service.coordinator.process({
		repositoryProfile: service.profile,
		job,
		github: service.publishGithub,
		store: service.store,
	});
}

function createRepositoryServices(profile) {
	const stateNamespace = resolve(profile.stateNamespace);
	const credentials = profile.credentials ?? {};
	const readToken = credentials.githubReadTokenEnv ? process.env[credentials.githubReadTokenEnv] : undefined;
	const statusTokenEnv = credentials.githubStatusTokenEnv ?? credentials.githubCheckRunTokenEnv;
	const statusToken = statusTokenEnv ? process.env[statusTokenEnv] : readToken;
	const sshKeyPath = credentials.gitSshKeyPathEnv ? process.env[credentials.gitSshKeyPathEnv] : undefined;
	const readGithub = new GitHubRestAdapter({ token: readToken });
	const publishGithub = new GitHubRestAdapter({ token: statusToken });
	const git = new GitCliAdapter({ sshKeyPath });
	const store = new SqliteJobStore(join(stateNamespace, "big-brother.sqlite"));
	const workspaceManager = new WorkspaceManager({ rootDir: join(stateNamespace, "workspaces"), git });
	const evidence = new GitReviewEvidenceAdapter({ git });
	const supervisor = new PrimeRuntimeSupervisor({ runtimeFactory: new PrimeRpcRuntimeFactory() });
	const coordinator = new ReviewCoordinator({
		workspaceManager,
		runtimeSupervisor: supervisor,
		evidenceProvider: ({ workspace, job }) => evidence.collect({ directory: workspace.directory, commitSha: job.commitSha }),
	});
	return {
		profile,
		readGithub,
		publishGithub,
		store,
		coordinator,
		close: async () => {
			await supervisor.stopAll();
			store.close();
		},
	};
}

function requireValue(args, index, option) {
	const value = args[index];
	if (!value || value.startsWith("--")) throw new Error(`${option} requires a value`);
	return value;
}

function delay(milliseconds) {
	return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}

const CLI_HELP = `Big Brother repository review service

Usage:
  big-brother agent
  big-brother config validate --config <path>
  big-brother review --config <path> --repo <owner/name> --commit <sha>
  big-brother watch --config <path> [--once] [--interval-ms <n>]
  big-brother service render <launchd|systemd> --config <path> --executable <path>

big-brother agent starts the independent Prime-compatible agent. Inside it,
use /login to configure provider authentication and /model to choose a
model. The watch/review commands reuse that Big Brother agent identity.
Big Brother watch/review operations never modify GitHub source. They publish an
advisory Commit Status and Prime-approved Review finding issues.

big-brother service render prints a foreground-watch service definition. Redirect
the output to a launchd plist or systemd unit after reviewing its paths.
`;

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	runCli(process.argv.slice(2)).catch((error) => {
		console.error(`big-brother: ${error.message}`);
		process.exitCode = 1;
	});
}
