import { spawnSync } from "node:child_process";
import { closeSync, fsyncSync, openSync, readFileSync, rmSync, writeSync } from "node:fs";
import { win32 } from "node:path";
import { getProcessStartId } from "./session-lease.js";
export const ORPHAN_PROCESS_JOURNAL_ENV = "PRIME_AGENT_INTERNAL_ORPHAN_PROCESS_JOURNAL";
export function recordOrphanProcessState(pid, active) {
    const path = process.env[ORPHAN_PROCESS_JOURNAL_ENV];
    if (!path || !Number.isInteger(pid) || pid <= 0) {
        return;
    }
    const processStartId = active ? getProcessStartId(pid) : undefined;
    const record = {
        version: 1,
        pid,
        ownerPid: process.pid,
        ...(processStartId ? { processStartId } : {}),
        active,
        recordedAt: new Date().toISOString(),
    };
    try {
        const descriptor = openSync(path, "a", 0o600);
        try {
            writeSync(descriptor, `${JSON.stringify(record)}\n`);
            fsyncSync(descriptor);
        }
        finally {
            closeSync(descriptor);
        }
    }
    catch {
        // Process tracking must not make a successfully spawned command fail.
    }
}
export function readActiveOrphanProcesses(path, ownerPid) {
    let contents;
    try {
        contents = readFileSync(path, "utf8");
    }
    catch (error) {
        if (error.code === "ENOENT") {
            return [];
        }
        throw error;
    }
    const latest = new Map();
    for (const line of contents.split("\n")) {
        if (!line) {
            continue;
        }
        try {
            const record = JSON.parse(line);
            if (record.version === 1 &&
                Number.isInteger(record.pid) &&
                (record.pid ?? 0) > 0 &&
                record.ownerPid === ownerPid &&
                typeof record.active === "boolean" &&
                typeof record.recordedAt === "string") {
                latest.set(record.pid, record);
            }
        }
        catch {
            // A crash can truncate only the final append.
        }
    }
    // Pid-only actives (no processStartId) still surface from old journals or
    // host writes whose start-id query failed; reapers decide per-platform.
    return [...latest.values()]
        .filter((record) => record.active && (record.processStartId === undefined || typeof record.processStartId === "string"))
        .map((record) => ({
        pid: record.pid,
        ...(Number.isInteger(record.kernelPid) ? { kernelPid: record.kernelPid } : {}),
        ...(typeof record.processStartId === "string" ? { processStartId: record.processStartId } : {}),
    }));
}
export function isOrphanProcessIdentityCurrent(orphan) {
    // Pid-only records can never claim identity (undefined === undefined must not match).
    return orphan.processStartId !== undefined && getProcessStartId(orphan.pid) === orphan.processStartId;
}
/**
 * Identity-free records cannot prove the pid still names the journaled process.
 * On win32 the kernel's kill-on-close job already reaped its tree when it died,
 * so a bare-pid taskkill only risks killing a reused pid. POSIX keeps the
 * best-effort kill (group-scoped, and the spawn gate makes pid-only actives
 * host-written rarities there).
 */
export function shouldReapOrphanProcess(orphan) {
    if (orphan.processStartId === undefined) {
        return process.platform !== "win32";
    }
    return isOrphanProcessIdentityCurrent(orphan);
}
export function clearOrphanProcessJournal(path) {
    rmSync(path, { force: true });
}
// Kills still-active bash() children journaled by the given kernel pid; sibling kernels' records are untouched.
export function reapKernelOrphanProcesses(kernelPid) {
    const path = process.env[ORPHAN_PROCESS_JOURNAL_ENV];
    if (!path || !Number.isInteger(kernelPid) || kernelPid <= 0) {
        return;
    }
    let orphans;
    try {
        orphans = readActiveOrphanProcesses(path, process.pid);
    }
    catch {
        return;
    }
    for (const orphan of orphans) {
        if (orphan.kernelPid !== kernelPid || orphan.pid === kernelPid) {
            continue;
        }
        if (!shouldReapOrphanProcess(orphan)) {
            continue;
        }
        // Inactive only after a delivered signal; a stale record is neutralized by the startId check.
        if (killOrphanProcess(orphan.pid)) {
            recordOrphanProcessState(orphan.pid, false);
        }
    }
}
// Hardened cross-platform tree kill for journaled orphans: absolute System32
// taskkill /T on win32 (a bare name could resolve a planted CWD taskkill.exe),
// process-group then pid SIGKILL elsewhere.
export function killOrphanProcess(pid) {
    if (process.platform === "win32") {
        // In-kernel bash() kill paths use taskkill /T; the reaper must kill the same tree, not just the shell pid.
        const result = spawnSync(win32.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "taskkill.exe"), ["/F", "/T", "/PID", String(pid)], {
            stdio: "ignore",
            timeout: 10_000,
            env: { ...process.env, NoDefaultCurrentDirectoryInExePath: "1" },
        });
        return result.status === 0;
    }
    try {
        process.kill(-pid, "SIGKILL");
        return true;
    }
    catch {
        try {
            process.kill(pid, "SIGKILL");
            return true;
        }
        catch {
            // The orphan may already have exited.
        }
    }
    return false;
}
//# sourceMappingURL=orphan-process-journal.js.map