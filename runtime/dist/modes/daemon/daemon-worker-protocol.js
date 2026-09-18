import { closeSync, readFileSync } from "node:fs";
export { SESSION_LEASE_OWNER_ID_ENV, SESSION_LEASES_ENABLED_ENV } from "../../core/session-lease.js";
export const DAEMON_WORKER_ROLE_ENV = "PRIME_AGENT_INTERNAL_DAEMON_WORKER";
export const DAEMON_WORKER_TOKEN_ENV = "PRIME_AGENT_INTERNAL_DAEMON_WORKER_TOKEN";
export const DAEMON_WORKER_ACTIVE_SESSION_ID_ENV = "PRIME_AGENT_INTERNAL_DAEMON_WORKER_ACTIVE_SESSION_ID";
export const DAEMON_WORKER_SUPERVISOR_SOCKET_ENV = "PRIME_AGENT_INTERNAL_DAEMON_SUPERVISOR_SOCKET";
export const DAEMON_WORKER_RECOVERY_JOURNAL_ENV = "PRIME_AGENT_INTERNAL_DAEMON_WORKER_RECOVERY_JOURNAL";
export const DAEMON_WORKER_STARTUP_GATE_FD_ENV = "PRIME_AGENT_INTERNAL_DAEMON_WORKER_STARTUP_GATE_FD";
export const DAEMON_WORKER_STARTUP_GATE_COMMIT = "start\n";
export function durableDaemonCreateCommand(command) {
    return {
        type: "create",
        ...(command.sessionPath !== undefined ? { sessionPath: command.sessionPath } : {}),
        ...(command.noSession !== undefined ? { noSession: command.noSession } : {}),
    };
}
export function durableDaemonWorkerDescriptor(descriptor) {
    const versionOneCreateCommand = descriptor.createCommand;
    const versionOneConfig = descriptor.version === 1 &&
        typeof versionOneCreateCommand.config === "object" &&
        versionOneCreateCommand.config !== null
        ? versionOneCreateCommand.config
        : undefined;
    const sessionDir = descriptor.sessionDir ??
        (typeof versionOneConfig?.sessionDir === "string" ? versionOneConfig.sessionDir : undefined);
    const telemetryDisabled = descriptor.telemetryDisabled === true || versionOneConfig?.telemetryDisabled === true;
    return {
        version: 2,
        workerId: descriptor.workerId,
        pid: descriptor.pid,
        ...(descriptor.processStartId !== undefined ? { processStartId: descriptor.processStartId } : {}),
        socketPath: descriptor.socketPath,
        recoveryJournalPath: descriptor.recoveryJournalPath,
        ...(descriptor.orphanProcessJournalPath !== undefined
            ? { orphanProcessJournalPath: descriptor.orphanProcessJournalPath }
            : {}),
        supervisorSocketPath: descriptor.supervisorSocketPath,
        authenticationToken: descriptor.authenticationToken,
        rootActiveSessionId: descriptor.rootActiveSessionId,
        ...(descriptor.ownerClientId !== undefined ? { ownerClientId: descriptor.ownerClientId } : {}),
        ...(descriptor.rootSessionId !== undefined ? { rootSessionId: descriptor.rootSessionId } : {}),
        ...(descriptor.sessionFile !== undefined ? { sessionFile: descriptor.sessionFile } : {}),
        ...(sessionDir !== undefined ? { sessionDir } : {}),
        ...(telemetryDisabled ? { telemetryDisabled: true } : {}),
        createdAt: descriptor.createdAt,
        updatedAt: descriptor.updatedAt,
        lifecycle: descriptor.lifecycle,
        createCommand: durableDaemonCreateCommand(descriptor.createCommand),
        consecutiveFailures: descriptor.consecutiveFailures,
        ...(descriptor.stopRequestedAt !== undefined ? { stopRequestedAt: descriptor.stopRequestedAt } : {}),
        ...(descriptor.archiveOnStop !== undefined ? { archiveOnStop: descriptor.archiveOnStop } : {}),
        ...(descriptor.lastFailureAt !== undefined ? { lastFailureAt: descriptor.lastFailureAt } : {}),
        ...(descriptor.lifecycle === "failed" ? { lastError: "Waiting for a client with fresh runtime context" } : {}),
    };
}
export function isDaemonWorkerProcess(environment = process.env) {
    return environment[DAEMON_WORKER_ROLE_ENV] === "1";
}
export function waitForDaemonWorkerStartupGate(environment = process.env) {
    const rawFd = environment[DAEMON_WORKER_STARTUP_GATE_FD_ENV];
    if (rawFd === undefined) {
        return;
    }
    delete environment[DAEMON_WORKER_STARTUP_GATE_FD_ENV];
    const fd = Number(rawFd);
    if (!Number.isInteger(fd) || fd < 3) {
        throw new Error("Daemon session worker has an invalid startup gate");
    }
    let marker;
    try {
        marker = readFileSync(fd, "utf8");
    }
    finally {
        closeSync(fd);
    }
    if (marker !== DAEMON_WORKER_STARTUP_GATE_COMMIT) {
        throw new Error("Daemon session worker startup was cancelled");
    }
}
export function requireDaemonWorkerAuthenticationToken(environment = process.env) {
    const token = environment[DAEMON_WORKER_TOKEN_ENV];
    if (!token) {
        throw new Error("Daemon session worker is missing its authentication token");
    }
    return token;
}
export function isDaemonWorkerFrameHeader(value) {
    if (!value || typeof value !== "object") {
        return false;
    }
    const candidate = value;
    if (candidate.kind === "command") {
        return typeof candidate.requestId === "string" && typeof candidate.commandType === "string";
    }
    return (candidate.kind === "outbound" &&
        typeof candidate.outboundType === "string" &&
        (candidate.requestId === undefined || typeof candidate.requestId === "string") &&
        (candidate.activeSessionId === undefined || typeof candidate.activeSessionId === "string") &&
        (candidate.snapshotId === undefined || typeof candidate.snapshotId === "string") &&
        (candidate.sessionEventType === undefined || typeof candidate.sessionEventType === "string") &&
        (candidate.snapshotPurpose === undefined ||
            candidate.snapshotPurpose === "attach" ||
            candidate.snapshotPurpose === "replacement" ||
            candidate.snapshotPurpose === "catchup") &&
        (candidate.payloadEncoding === undefined ||
            candidate.payloadEncoding === "jsonl" ||
            candidate.payloadEncoding === "assistant-delta"));
}
//# sourceMappingURL=daemon-worker-protocol.js.map