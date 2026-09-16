export declare const ORPHAN_PROCESS_JOURNAL_ENV = "PRIME_AGENT_INTERNAL_ORPHAN_PROCESS_JOURNAL";
export interface ActiveOrphanProcess {
    pid: number;
    kernelPid?: number;
    /** Missing on identity-free records: old journals or host writes whose start-id query failed (kernels no longer write pid-only records). */
    processStartId?: string;
}
export declare function recordOrphanProcessState(pid: number, active: boolean): void;
export declare function readActiveOrphanProcesses(path: string, ownerPid: number): ActiveOrphanProcess[];
export declare function isOrphanProcessIdentityCurrent(orphan: ActiveOrphanProcess): boolean;
/**
 * Identity-free records cannot prove the pid still names the journaled process.
 * On win32 the kernel's kill-on-close job already reaped its tree when it died,
 * so a bare-pid taskkill only risks killing a reused pid. POSIX keeps the
 * best-effort kill (group-scoped, and the spawn gate makes pid-only actives
 * host-written rarities there).
 */
export declare function shouldReapOrphanProcess(orphan: ActiveOrphanProcess): boolean;
export declare function clearOrphanProcessJournal(path: string): void;
export declare function reapKernelOrphanProcesses(kernelPid: number): void;
export declare function killOrphanProcess(pid: number): boolean;
//# sourceMappingURL=orphan-process-journal.d.ts.map