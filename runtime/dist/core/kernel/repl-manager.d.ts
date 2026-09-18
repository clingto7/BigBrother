import { type ExecuteOptions, type ExecuteResult, type KernelManagerOptions, type KernelShutdownOptions, type KernelStartOptions } from "./shared.js";
import { type RestoreResult, type SnapshotResult } from "./state-snapshot.js";
export declare class ReplKernelManager {
    private readonly options;
    private readonly handledHostRequestIds;
    private child?;
    private readyDeferred?;
    private kernelStderr;
    /** Serializes execute() calls — the runtime runs one request at a time. */
    private executionQueue;
    private activeExecution?;
    private readonly activeExecutionIdleWaiters;
    private readonly lateSentAgentMessageHandlers;
    /** Resolvers for done events outside the active execution (the shutdown reply). */
    private readonly pendingDoneWaiters;
    private lastCellCode?;
    /** Unattributed stream text that arrived between cells; surfaced on the next execution. */
    private pendingBackgroundOutput;
    private pendingBackgroundOutputTruncated;
    private readonly inFlightHostRequests;
    private state;
    /** Bumped by every teardown so a stale in-flight doStart can never touch a newer kernel. */
    private startGeneration;
    /** Generation whose graceful shutdown() owns the teardown, so the exit handler must not run it. */
    private gracefulShutdownGeneration?;
    private gracefulShutdownPromise?;
    /** Memoized so concurrent callers all await the same in-flight startup. */
    private startPromise?;
    /** Pending debounced auto-snapshot, if one has been scheduled. */
    private snapshotTimer?;
    /** While the final dispose snapshot is flushing, new external executions are rejected. */
    private flushingSnapshotForDispose;
    /** In-flight final snapshot flush; concurrent teardowns join it instead of re-flushing. */
    private snapshotFlushForDispose?;
    /** Repairs a child whose dedicated protocol stream emitted an invalid frame. */
    private protocolRepairPromise?;
    private protocolRepairOwner?;
    /** Corruption seen while still "starting" (e.g. ready and garbage in one chunk) fails that start. */
    private startupProtocolError?;
    /** A repair discarded its kernel: the next fresh start must re-run the runtime bootstrap. */
    private pendingRebootstrap;
    /** Restore the saved namespace on that fresh start too (false when the snapshot itself is the declared culprit). */
    private pendingRestore;
    private rebootstrapPromise?;
    private teardownInFlight;
    constructor(options: KernelManagerOptions);
    get ownerSessionId(): string | undefined;
    private appendKernelDiagnostic;
    start(options?: KernelStartOptions): Promise<void>;
    private doStart;
    /** True when a teardown (or newer start) superseded the start that captured `generation`. */
    private startStale;
    private wireChild;
    private failProtocolFrame;
    private repairProtocolChild;
    private bootstrapRepairedKernel;
    private ensureKernelRebootstrapped;
    private reprovisionFreshKernel;
    /** Kill the current child and settle at clean idle, so the next start spawns fresh. */
    private killChildToIdle;
    private finishFailedProtocolRepair;
    private supersedeProtocolRepair;
    private waitForProtocolRepair;
    private waitForReady;
    /** Write one JSON-lines request frame; resolves when the OS accepted the bytes. */
    private writeLine;
    private handleEvent;
    execute(code: string, opts?: ExecuteOptions): Promise<ExecuteResult>;
    private enqueueExecute;
    private enqueueRequest;
    private executeInner;
    private appendBackgroundOutput;
    private finishActiveExecution;
    private resolveExecution;
    private dispatchLateSentAgentMessage;
    private registerLateSentAgentMessageHandler;
    private rejectActiveExecution;
    private notifyActiveExecutionIdle;
    private waitForActiveExecutionToClear;
    private waitForActiveExecutionToClearForReuse;
    private startHostRequest;
    private handleHostRequest;
    private interrupt;
    private cleanupResources;
    private waitForKernelExit;
    private waitForHostRequestsToSettle;
    /** Resolves true when this call performed the cleanup (false: a concurrent teardown won; a joiner's options are ignored - the first caller's policy wins). */
    shutdown(opts?: KernelShutdownOptions): Promise<boolean>;
    private performShutdown;
    restart(): Promise<void>;
    kill(): Promise<void>;
    /**
     * Serialize the user namespace to disk (best-effort, per-variable). No-op when
     * the kernel isn't running or no snapshot target was configured. Never throws.
     */
    snapshotState(): Promise<SnapshotResult | null>;
    /** Persist the namespace, then remove variables above the per-variable cap. */
    pruneOversizedVariables(): Promise<SnapshotResult | null>;
    private captureSnapshot;
    /**
     * Revive a previously snapshotted namespace into the kernel. Call right after
     * start() and before the runtime bootstrap, which then refreshes live handles
     * (rlm, skills) over anything restored. Never throws.
     */
    restoreState(): Promise<RestoreResult | null>;
    private performRestore;
    /** Live user-defined top-level names, or null if the kernel isn't running. Never throws. */
    listNamespaceNames(signal?: AbortSignal): Promise<string[] | null>;
    private scheduleSnapshot;
    private clearSnapshotTimer;
    private flushSnapshotForDispose;
    private runSnapshotFlushForDispose;
    /** Synchronous best-effort cleanup. Safe to call from `process.on('exit')`. */
    disposeSync(): void;
    get isRunning(): boolean;
}
//# sourceMappingURL=repl-manager.d.ts.map