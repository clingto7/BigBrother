import { type SessionInfo } from "../../core/session-manager.js";
/**
 * Daemon-owned RLM spawn ledger.
 *
 * One append-only JSONL file per sessions dir, written by daemon processes at
 * the moments they admit a spawn, perform a rename, or record a deletion.
 * Family topology (parent/child edges, depths, names) is read back from this
 * file instead of being re-derived from writer-owned session headers,
 * registries, and bodies at read time.
 *
 * Multi-writer reality: the supervisor and each session worker hold their own
 * instance over the same file. Appends are single small O_APPEND writes (well
 * under PIPE_BUF-scale sizes), whose atomicity we rely on for interleaving;
 * reads re-read the whole file per operation, so cross-process staleness is
 * bounded to in-flight appends. In-process appends are serialized on an
 * internal queue.
 */
export declare const RLM_LEDGER_DIR = "rlm-ledger";
/** Bounded read: a ledger beyond these limits fails closed loudly. */
export declare const RLM_LEDGER_MAX_BYTES: number;
export declare const RLM_LEDGER_MAX_RECORDS = 100000;
export type RlmLedgerDeleteReason = "user" | "parent-teardown" | "revoked" | "gc";
export interface RlmLedgerSpawnRecord {
    v: 1;
    op: "spawn";
    at: string;
    childId: string;
    parent: string;
    child: string;
    depth: number;
    name: string;
}
export interface RlmLedgerRenameRecord {
    v: 1;
    op: "rename";
    at: string;
    childId: string;
    child: string;
    name: string;
}
export interface RlmLedgerDeleteRecord {
    v: 1;
    op: "delete";
    at: string;
    childId: string;
    child: string;
    reason: RlmLedgerDeleteReason;
}
export type RlmLedgerRecord = RlmLedgerSpawnRecord | RlmLedgerRenameRecord | RlmLedgerDeleteRecord;
/** A live edge after replaying the ledger (last-writer-wins per childId+child). */
export interface RlmLedgerEdge {
    childId: string;
    parent: string;
    child: string;
    depth: number;
    name: string;
    deleted?: RlmLedgerDeleteReason;
}
/** Minimal registry-entry shape the seeder consumes (matches the daemon writer). */
export interface RlmLedgerSeedRegistryEntry {
    childId: string;
    sessionName: string;
    sessionFile: string;
    rlmDepth?: number;
    status: "running" | "completed" | "deleted";
}
export interface LegacyRlmSubagentRegistryEntry extends RlmLedgerSeedRegistryEntry {
    type: "rlm_subagent";
    sessionDir: string;
    parentSessionId: string;
    parentSessionFile?: string;
    rlmMaxDepth?: number;
    rlmParentNodeId?: string;
    prompt?: string;
    spawnCode?: string;
    model?: {
        provider: string;
        modelId: string;
    };
    createdAt: number;
    updatedAt: string;
}
export interface RlmLedgerSeedSource {
    readRegistryForSessionFile(sessionFile: string): Promise<RlmLedgerSeedRegistryEntry[]>;
}
export declare function readLegacyRlmSubagentRegistry(path: string, options?: {
    throwOnReadError?: boolean;
    log?: (message: string) => void;
}): Promise<LegacyRlmSubagentRegistryEntry[]>;
export declare function createRlmLedgerRegistrySeedSource(): RlmLedgerSeedSource;
export declare function rlmLedgerPath(agentDir: string, sessionsDir: string): string;
/**
 * Per-sessions-dir spawn ledger. All operations are serialized on an internal
 * queue; the first operation lazily seeds a missing ledger from the existing
 * per-parent registries (memoized; a seeding failure degrades to an empty
 * ledger and is never fail-closed).
 */
export declare class RlmSpawnLedger {
    private readonly seedSource?;
    private readonly log;
    private readonly path;
    private readonly canonicalSessionsDir;
    private queue;
    private seedAttempted;
    constructor(agentDir: string, sessionsDir: string, seedSource?: RlmLedgerSeedSource | undefined, log?: (message: string) => void);
    get ledgerPath(): string;
    appendSpawn(input: {
        childId: string;
        parent: string;
        child: string;
        depth: number;
        name: string;
    }): Promise<void>;
    appendRename(input: {
        childId: string;
        child: string;
        name: string;
    }): Promise<void>;
    /** Rename by child session path alone (offline saved-session rename knows no childId). */
    appendRenameByChildPath(child: string, name: string): Promise<void>;
    appendDelete(input: {
        childId: string;
        child: string;
        reason: RlmLedgerDeleteReason;
    }): Promise<void>;
    /** Resolves once every operation enqueued so far has completed (durably, for appends). */
    flush(): Promise<void>;
    /**
     * Replay edges without liveness reconciliation. Deleted edges are filtered
     * by default; `includeDeleted` keeps the tombstones (marked with their
     * delete reason) for consumers that need a deleted child's identity, such
     * as cleanup retries.
     */
    edges(includeDeleted?: boolean): Promise<RlmLedgerEdge[]>;
    /**
     * Family of every session rooted in this ledger's sessions dir: bounded
     * readdir of *.jsonl roots as depth-0 rows plus live ledger edges, both
     * reconciled by stat (a dead parent or child drops the edge). Depths are
     * verified parent+1 between ledger-known depths; a contradictory edge is
     * dropped and logged, never fails the whole family.
     */
    family(): Promise<SessionInfo[]>;
    /** Same-parent rows for a child session path, including the child itself. */
    siblings(sessionPath: string): Promise<SessionInfo[]>;
    private enqueue;
    private appendSpawnUnlocked;
    private familyUnlocked;
    private sessionRow;
    private seed;
    private publishSeedFile;
    private appendRecord;
    private truncateTornTailSync;
    private replaySync;
}
//# sourceMappingURL=rlm-ledger.d.ts.map