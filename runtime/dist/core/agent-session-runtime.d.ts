import type { AgentSession } from "./agent-session.js";
import type { AgentSessionRuntimeConfig } from "./agent-session-config.js";
import type { AgentSessionCreationOptions, AgentSessionRuntimeDiagnostic, AgentSessionServices } from "./agent-session-services.js";
import type { ReplacedSessionContext, SessionStartEvent } from "./extensions/index.js";
import type { CreateRlmSubagentRuntimeOptions, RlmSubagentRuntime, SubagentRuntimeHost } from "./rlm-runtime.js";
import type { CreateAgentSessionResult } from "./sdk.js";
import { type SessionLease } from "./session-lease.js";
import { SessionManager } from "./session-manager.js";
export { SessionImportFileNotFoundError } from "./session-import-errors.js";
export interface CreateAgentSessionRuntimeResult extends CreateAgentSessionResult {
    services: AgentSessionServices;
    diagnostics: AgentSessionRuntimeDiagnostic[];
}
export type CreateAgentSessionRuntimeFactory = (options: {
    cwd: string;
    agentDir: string;
    sessionManager: SessionManager;
    sessionStartEvent?: SessionStartEvent;
    sessionConfig?: AgentSessionRuntimeConfig;
    sessionOptions?: AgentSessionCreationOptions;
}) => Promise<CreateAgentSessionRuntimeResult>;
export type AgentSessionRuntimeKind = "top-level" | "subagent";
export interface AgentSessionRuntimeMetadata {
    kind: AgentSessionRuntimeKind;
    createdAt: number;
    parentActiveSessionId?: string;
    parentSessionId?: string;
    parentSessionFile?: string;
    rlmChildId?: string;
    rlmParentNodeId?: string;
    rehydratedCompleted?: boolean;
    prompt?: string;
    spawnCode?: string;
    sessionDir?: string;
}
export declare class AgentSessionRuntime implements SubagentRuntimeHost {
    private _session;
    private _services;
    private readonly createRuntime;
    private _diagnostics;
    private _modelFallbackMessage?;
    private readonly sessionConfig?;
    private readonly _metadata;
    private _sessionLease?;
    private rebindSession?;
    private readonly sessionReplacedListeners;
    private runtimeEnvScope?;
    private beforeSessionInvalidate?;
    private subagentRuntimeHost?;
    private subagentRuntimes;
    private disposePromise?;
    constructor(_session: AgentSession, _services: AgentSessionServices, createRuntime: CreateAgentSessionRuntimeFactory, _diagnostics?: AgentSessionRuntimeDiagnostic[], _modelFallbackMessage?: string | undefined, sessionConfig?: AgentSessionRuntimeConfig | undefined, _metadata?: AgentSessionRuntimeMetadata, _sessionLease?: SessionLease | undefined);
    get services(): AgentSessionServices;
    get session(): AgentSession;
    get cwd(): string;
    get diagnostics(): readonly AgentSessionRuntimeDiagnostic[];
    get modelFallbackMessage(): string | undefined;
    get metadata(): AgentSessionRuntimeMetadata;
    get runtimeConfig(): AgentSessionRuntimeConfig | undefined;
    setRebindSession(rebindSession?: (session: AgentSession) => Promise<void>): void;
    onSessionReplaced(listener: (session: AgentSession) => void | Promise<void>): () => void;
    /**
     * Host-installed scope wrapping every runtime rebuild (new/switch/fork/
     * import and subagent creation), during which extensions re-load. The
     * daemon uses it to apply the session's client env for load-time captures.
     */
    setRuntimeEnvScope(scope?: <T>(fn: () => Promise<T>) => Promise<T>): void;
    private scopedBuild;
    setSubagentRuntimeHost(host?: SubagentRuntimeHost): void;
    /**
     * Set a synchronous callback that runs after `session_shutdown` handlers finish
     * but before the current session is invalidated.
     *
     * This is for host-owned UI teardown that must not yield to the event loop,
     * such as detaching extension-provided TUI components before the old extension
     * context becomes stale.
     */
    setBeforeSessionInvalidate(beforeSessionInvalidate?: () => void): void;
    private emitBeforeSwitch;
    private emitBeforeFork;
    private teardownCurrent;
    private bindRuntimeHost;
    private apply;
    private acquireReplacementLease;
    private releaseUncommittedLease;
    private releaseSessionLease;
    private commitReplacementLease;
    private buildAndApplyReplacement;
    private teardownForReplacement;
    private disposeSubagentRuntimes;
    private disposeHostedSubagentRuntimes;
    listSubagentRuntimes(): readonly AgentSessionRuntime[];
    createRlmSubagentRuntime(options: CreateRlmSubagentRuntimeOptions): Promise<RlmSubagentRuntime>;
    deleteRlmSubagentRuntime(childId: string, session: AgentSession): Promise<void>;
    private finishSessionReplacement;
    switchSession(sessionPath: string, options?: {
        cwdOverride?: string;
        withSession?: (ctx: ReplacedSessionContext) => Promise<void>;
    }): Promise<{
        cancelled: boolean;
    }>;
    newSession(options?: {
        parentSession?: string;
        setup?: (sessionManager: SessionManager) => Promise<void>;
        withSession?: (ctx: ReplacedSessionContext) => Promise<void>;
    }): Promise<{
        cancelled: boolean;
    }>;
    fork(entryId: string, options?: {
        position?: "before" | "at";
        withSession?: (ctx: ReplacedSessionContext) => Promise<void>;
    }): Promise<{
        cancelled: boolean;
        selectedText?: string;
    }>;
    /**
     * Import a session JSONL file and switch runtime state to the imported session.
     *
     * @returns `{ cancelled: true }` when cancelled by `session_before_switch`, otherwise `{ cancelled: false }`.
     * @throws {SessionImportFileNotFoundError} When the input path does not exist.
     * @throws {MissingSessionCwdError} When the imported session cwd cannot be resolved and no override is provided.
     */
    importFromJsonl(inputPath: string, cwdOverride?: string): Promise<{
        cancelled: boolean;
    }>;
    private disposeOnce;
    dispose(): Promise<void>;
}
export declare function createAgentSessionRuntime(createRuntime: CreateAgentSessionRuntimeFactory, options: {
    cwd: string;
    agentDir: string;
    sessionManager: SessionManager;
    sessionStartEvent?: SessionStartEvent;
    sessionConfig?: AgentSessionRuntimeConfig;
    sessionOptions?: AgentSessionCreationOptions;
    runtimeMetadata?: AgentSessionRuntimeMetadata;
    sessionLease?: SessionLease;
}): Promise<AgentSessionRuntime>;
export { type AgentSessionRuntimeDiagnostic, type AgentSessionServices, type CreateAgentSessionFromServicesOptions, type CreateAgentSessionServicesOptions, createAgentSessionFromServices, createAgentSessionServices, } from "./agent-session-services.js";
//# sourceMappingURL=agent-session-runtime.d.ts.map