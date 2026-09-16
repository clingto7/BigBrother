import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ImageContent, Message, ServiceTier, TextContent, Usage } from "@earendil-works/pi-ai";
import { type GitContext } from "../utils/git.js";
import { type BashExecutionMessage, type CustomMessage } from "./messages.js";
export declare const CURRENT_SESSION_VERSION = 3;
export interface SessionHeader {
    type: "session";
    version?: number;
    id: string;
    timestamp: string;
    cwd: string;
    parentSession?: string;
    rlmDepth?: number;
    git?: GitContext;
}
export interface NewSessionOptions {
    id?: string;
    parentSession?: string;
    rlmDepth?: number;
}
export type SessionPersistListener = (sessionFile: string) => void;
export interface SessionEntryBase {
    type: string;
    id: string;
    parentId: string | null;
    timestamp: string;
}
export interface SessionMessageEntry extends SessionEntryBase {
    type: "message";
    message: AgentMessage;
}
export interface ThinkingLevelChangeEntry extends SessionEntryBase {
    type: "thinking_level_change";
    thinkingLevel: string;
}
export interface ServiceTierChangeEntry extends SessionEntryBase {
    type: "service_tier_change";
    serviceTier: ServiceTier;
}
export interface ModelChangeEntry extends SessionEntryBase {
    type: "model_change";
    provider: string;
    modelId: string;
}
export interface CompactionEntry<T = unknown> extends SessionEntryBase {
    type: "compaction";
    summary: string;
    firstKeptEntryId: string;
    tokensBefore: number;
    details?: T;
    fromHook?: boolean;
    customInstructions?: string;
}
export interface BranchSummaryEntry<T = unknown> extends SessionEntryBase {
    type: "branch_summary";
    fromId: string;
    summary: string;
    details?: T;
    fromHook?: boolean;
}
export interface CustomEntry<T = unknown> extends SessionEntryBase {
    type: "custom";
    customType: string;
    data?: T;
}
/**
 * Records usage folded into a parent assistant message after an RLM child run.
 * The child usage is kept separately so audit/UI code can explain why the
 * parent turn's aggregate usage exceeds the parent model response itself.
 */
export interface ChildUsageAttributionEntry extends SessionEntryBase {
    type: "child_usage_attributed";
    targetId: string;
    childUsage: Usage;
    aggregateUsage: Usage;
    origin?: "spawn_task" | "agent_message" | "direct_user";
}
export interface LabelEntry extends SessionEntryBase {
    type: "label";
    targetId: string;
    label: string | undefined;
}
export interface SessionInfoEntry extends SessionEntryBase {
    type: "session_info";
    name?: string;
}
export type SessionStateStatus = "active" | "archived" | "crash";
export interface SessionState {
    status: SessionStateStatus;
}
export interface SessionStateEntry extends SessionEntryBase {
    type: "session_state";
    state: SessionState;
}
export type AgentTaskState = "needs_input" | "completed";
export interface AgentStatus {
    summary: string;
    taskState?: AgentTaskState;
    basedOnMessageCount: number;
}
export interface AgentStatusEntry extends SessionEntryBase {
    type: "agent_status";
    status: AgentStatus;
}
export interface GitStateEntry extends SessionEntryBase {
    type: "git_state";
    git: GitContext;
}
export interface CustomMessageEntry<T = unknown> extends SessionEntryBase {
    type: "custom_message";
    customType: string;
    content: string | (TextContent | ImageContent)[];
    details?: T;
    display: boolean;
}
export type SessionEntry = SessionMessageEntry | ThinkingLevelChangeEntry | ServiceTierChangeEntry | ModelChangeEntry | CompactionEntry | BranchSummaryEntry | CustomEntry | ChildUsageAttributionEntry | CustomMessageEntry | LabelEntry | SessionInfoEntry | SessionStateEntry | AgentStatusEntry | GitStateEntry;
export type FileEntry = SessionHeader | SessionEntry;
export interface SessionTreeFlatNode {
    entry: SessionEntry;
    label?: string;
    labelTimestamp?: string;
}
export interface SessionTreeNode extends SessionTreeFlatNode {
    children: SessionTreeNode[];
}
export interface SessionContext {
    messages: AgentMessage[];
    thinkingLevel: string;
    serviceTier: ServiceTier;
    model: {
        provider: string;
        modelId: string;
    } | null;
}
export interface SessionInfo {
    path: string;
    id: string;
    cwd: string;
    name?: string;
    state?: SessionState;
    parentSessionPath?: string;
    rlmDepth: number;
    created: Date;
    modified: Date;
    messageCount: number;
    firstMessage: string;
    allMessagesText: string;
    agentStatus?: AgentStatus;
}
export type ReadonlySessionManager = Pick<SessionManager, "getCwd" | "getSessionDir" | "getSessionId" | "getSessionFile" | "getLeafId" | "getLeafEntry" | "getEntry" | "getLabel" | "getBranch" | "getHeader" | "getEntries" | "getTree" | "getSessionName">;
export declare function getSessionArtifactsRoot(sessionDir: string): string;
export declare function getSessionArtifactPath(sessionDir: string, sessionId: string): string;
export declare function getSessionArtifactPathForFile(sessionFile: string, sessionId?: string): string;
export declare function migrateSessionEntries(entries: FileEntry[]): void;
export declare function parseSessionEntries(content: string): FileEntry[];
export declare function getLatestCompactionEntry(entries: SessionEntry[]): CompactionEntry | null;
export declare function buildSessionContext(entries: SessionEntry[], leafId?: string | null, byId?: Map<string, SessionEntry>): SessionContext;
export declare function getDefaultSessionDir(_cwd: string, agentDir?: string): string;
export declare function loadEntriesFromFile(filePath: string): FileEntry[];
export declare function loadEntriesFromFileAsync(filePath: string, options?: {
    streamThresholdBytes?: number;
}): Promise<FileEntry[]>;
export declare function resolveSessionRlmDepth(header: {
    rlmDepth?: number;
    parentSession?: string;
}, sessionPath: string): number;
export declare function findMostRecentSession(sessionDir: string): string | null;
export declare function findMostRecentSessionForCwd(sessionDir: string, cwd: string): string | null;
export declare function readSessionInfo(filePath: string): Promise<SessionInfo | null>;
export type SessionListProgress = (loaded: number, total: number) => void;
export type SessionListItem = (session: SessionInfo) => void;
export interface SessionListCallbacks {
    onProgress?: SessionListProgress;
    onSession?: SessionListItem;
}
export declare class SessionManager {
    private sessionId;
    private sessionFile;
    private sessionDir;
    private cwd;
    private persist;
    private flushed;
    private fileEntries;
    private byId;
    private labelsById;
    private labelTimestampsById;
    private leafId;
    private persistListeners;
    private constructor();
    /**
     * Switch to a different session file (used for resume and branching).
     * preloadedEntries must be loadEntriesFromFile(sessionFile) for the same path; it
     * lets the async daemon path skip the synchronous re-read.
     */
    setSessionFile(sessionFile: string, preloadedEntries?: FileEntry[]): void;
    newSession(options?: NewSessionOptions): string | undefined;
    private _buildIndex;
    private _rewriteFile;
    private _notifyPersistListeners;
    onPersist(listener: SessionPersistListener): () => void;
    isPersisted(): boolean;
    getCwd(): string;
    getSessionDir(): string;
    getSessionId(): string;
    getSessionFile(): string | undefined;
    materializeSessionFile(sessionDir?: string): string;
    getSessionArtifactDir(): string | undefined;
    /**
     * Force-write all in-memory entries to the session file immediately.
     * This bypasses the no-assistant guard in {@link _persist} so that
     * pre-model entries (session header, goal state, settings changes)
     * are durable on disk before the first assistant response.
     * No-op for in-memory (non-persisted) sessions.
     */
    flushNow(): void;
    _persist(entry: SessionEntry): void;
    private _appendEntry;
    appendMessage(message: Message | CustomMessage | BashExecutionMessage): string;
    appendThinkingLevelChange(thinkingLevel: string): string;
    appendServiceTierChange(serviceTier: ServiceTier): string;
    appendModelChange(provider: string, modelId: string): string;
    appendCompaction<T = unknown>(summary: string, firstKeptEntryId: string, tokensBefore: number, details?: T, fromHook?: boolean, customInstructions?: string): string;
    appendCustomEntry(customType: string, data?: unknown): string;
    appendCustomEntryWithRollback(customType: string, data?: unknown): string;
    appendChildUsageAttribution(targetId: string, childUsage: Usage, aggregateUsage: Usage, origin?: ChildUsageAttributionEntry["origin"]): string;
    appendSessionInfo(name: string): string;
    appendSessionState(state: SessionState): string;
    getSessionName(): string | undefined;
    getSessionState(): SessionState | undefined;
    /**
     * True when the session holds user-meaningful persisted content, as opposed to
     * only daemon-written bookkeeping (session_state, agent_status, git_state) or
     * the default model/thinking entries every new session is created with. Used by
     * the daemon discard guard to decide whether a message-less draft is safe to
     * delete (that guard always also requires zero messages).
     *
     * createAgentSession opens a new session with an optional leading `model_change`
     * followed by `thinking_level_change` and `service_tier_change`. That creation
     * prefix is skipped; anything beyond it is user content.
     */
    hasUserContent(): boolean;
    appendAgentStatus(status: AgentStatus): string;
    appendGitState(git: GitContext): string;
    recordGitStateIfChanged(): string | undefined;
    private getActiveGitContext;
    getLatestAgentStatus(): AgentStatus | undefined;
    appendCustomMessageEntry<T = unknown>(customType: string, content: string | (TextContent | ImageContent)[], display: boolean, details?: T): string;
    /**
     * Append a custom message, undoing the append if persistence fails so a
     * best-effort record never leaves an unsaved leaf for later entries.
     */
    appendCustomMessageEntryWithRollback<T = unknown>(customType: string, content: string | (TextContent | ImageContent)[], display: boolean, details?: T): string;
    private _appendEntryWithRollback;
    getLeafId(): string | null;
    getLeafEntry(): SessionEntry | undefined;
    getEntry(id: string): SessionEntry | undefined;
    getChildren(parentId: string): SessionEntry[];
    getLabel(id: string): string | undefined;
    appendLabelChange(targetId: string, label: string | undefined): string;
    getBranch(fromId?: string): SessionEntry[];
    buildSessionContext(): SessionContext;
    getHeader(): SessionHeader | null;
    getEntries(): SessionEntry[];
    getFlatTree(): SessionTreeFlatNode[];
    getTree(): SessionTreeNode[];
    branch(branchFromId: string): void;
    resetLeaf(): void;
    branchWithSummary(branchFromId: string | null, summary: string, details?: unknown, fromHook?: boolean): string;
    createBranchedSession(leafId: string): string | undefined;
    static create(cwd: string, sessionDir?: string): SessionManager;
    static open(path: string, sessionDir?: string, cwdOverride?: string): SessionManager;
    static openAsync(path: string, sessionDir?: string, cwdOverride?: string): Promise<SessionManager>;
    static continueRecent(cwd: string, sessionDir?: string): SessionManager;
    static inMemory(cwd?: string, sessionDir?: string): SessionManager;
    static forkFrom(sourcePath: string, targetCwd: string, sessionDir?: string): SessionManager;
    static list(cwd: string, sessionDir?: string, callbacks?: SessionListCallbacks): Promise<SessionInfo[]>;
    static listAll(callbacks?: SessionListCallbacks, sessionDir?: string): Promise<SessionInfo[]>;
}
//# sourceMappingURL=session-manager.d.ts.map