import { Agent, type AgentEvent, type AgentMessage, type AgentState, type AgentTool, type ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { ImageContent, Model, ServiceTier, TextContent, UserMessage } from "@earendil-works/pi-ai";
import { type AgentFamilyRosterResult, type AgentSessionMessage, type AgentSessionMessageController, type AgentSessionMessageListResult, type AgentSessionMessageReceipt } from "./agent-messages.js";
import { type AgentObserveAgentSnapshot, type AgentObserveController, type AgentObserveListResult, type AgentObserveRecentMessagesResult } from "./agent-observe.js";
import type { AuthSourceToken } from "./auth-storage.js";
import { type AgentAutonomousConfig, type AgentAutonomousStatus } from "./autonomous.js";
import { type BashResult } from "./bash-executor.js";
import { type CompactionResult } from "./compaction/index.js";
import { type ContextTreeNode } from "./context-tree.js";
import type { AgentCronJob, AgentRlmHeartbeatController } from "./cron-jobs.js";
import { type ContextUsage, type ExtensionCommandContextActions, type ExtensionErrorListener, ExtensionRunner, type ExtensionUIContext, type InputSource, type ReplacedSessionContext, type SessionStartEvent, type ShutdownHandler, type ToolDefinition, type ToolInfo } from "./extensions/index.js";
import { type GoalHostResponse, type GoalState } from "./goals.js";
import type { KernelSentAgentMessage } from "./kernel/index.js";
import type { AcpMcpServerConfig } from "./mcp/acp-mcp-types.js";
import type { McpManager } from "./mcp/mcp-manager.js";
import { type CustomMessage } from "./messages.js";
import type { ModelRegistry } from "./model-registry.js";
import { type PromptTemplate } from "./prompt-templates.js";
import { type AutoRefineReason, type AutoRefineReview, type RefinementPlan, type RefinementResult } from "./refinement/index.js";
import type { ResourceLoader } from "./resource-loader.js";
import { type RlmDeleteSubagentResult, type RlmFindModelsResult, type RlmListSubagentsResult, type RlmSpawnHandle, type SubagentRuntimeHost } from "./rlm-runtime.js";
import { type DeliveryPolicy, type DeliveryRecord, type QueuedMessageLane, type QueuedMessageMutation, type QueuedMessageMutationStatus, type SessionActionSnapshot, type WakePolicy } from "./session-action-store.js";
import type { BranchSummaryEntry, SessionContext } from "./session-manager.js";
import { SessionManager } from "./session-manager.js";
import type { SessionStats } from "./session-stats.js";
import type { SettingsManager } from "./settings-manager.js";
import { type SessionSlashCommand } from "./slash-commands.js";
import { type BashOperations } from "./tools/bash.js";
export type { GoalState, GoalStatus } from "./goals.js";
export type { SessionStats } from "./session-stats.js";
export { type ParsedSkillBlock, parseSkillBlock } from "./skill-blocks.js";
export type RlmChildAgentStatus = "queued" | "running" | "done" | "error" | "cancelled";
export interface RlmChildAgentActivity {
    kind: "waiting" | "writing" | "executing";
    toolName?: string;
}
export interface RlmChildAgentSnapshot {
    id: string;
    parentId?: string;
    activeSessionId?: string;
    sessionName?: string;
    model?: string;
    label: string;
    status: RlmChildAgentStatus;
    durationMs?: number;
    answerPreview?: string;
    toolUseCount?: number;
    tokenCount?: number;
    recap?: string;
    sessionDir: string;
    activity?: RlmChildAgentActivity;
    repliedSinceTask?: boolean;
    error?: string;
}
export type CompactionReason = "manual" | "threshold" | "overflow" | "requested";
export type AgentSessionEvent = AgentEvent | {
    type: "ipython_sent_agent_message";
    toolCallId: string;
    message: KernelSentAgentMessage;
} | {
    type: "session_action_update";
    actions: SessionActionSnapshot;
} | {
    type: "compaction_start";
    reason: CompactionReason;
    customInstructions?: string;
} | {
    type: "session_info_changed";
    name: string | undefined;
} | {
    type: "thinking_level_changed";
    level: ThinkingLevel;
} | {
    type: "service_tier_changed";
    serviceTier: ServiceTier;
} | {
    type: "compaction_end";
    reason: CompactionReason;
    result: CompactionResult | undefined;
    aborted: boolean;
    willRetry: boolean;
    errorMessage?: string;
    errorSeverity?: "warning" | "error";
    customInstructions?: string;
} | {
    type: "auto_retry_start";
    attempt: number;
    maxAttempts: number;
    delayMs: number;
    errorMessage: string;
} | {
    type: "auto_retry_end";
    success: boolean;
    attempt: number;
    finalError?: string;
} | {
    type: "auth_stale";
    provider: string;
    sourceTokens?: readonly AuthSourceToken[];
} | {
    type: "rlm_child_update";
    child: RlmChildAgentSnapshot;
} | {
    type: "recap_update";
    recap: string | undefined;
} | {
    type: "goal_update";
    goal: GoalState;
} | {
    type: "bash_start";
    command: string;
    excludeFromContext: boolean;
    transient?: boolean;
    runId?: string;
} | {
    type: "bash_output";
    chunk: string;
} | {
    type: "bash_end";
    exitCode: number | undefined;
    cancelled: boolean;
    truncated: boolean;
    fullOutputPath?: string;
    errorMessage?: string;
    transient?: boolean;
    runId?: string;
} | {
    type: "refine_complete";
    result: RefinementResult;
} | {
    type: "refine_failed";
    error: string;
};
export type AgentSessionEventListener = (event: AgentSessionEvent) => void;
export declare class CompactionSkippedError extends Error {
}
/** Thrown when a session_before_refine extension skips the refinement round. */
export declare class RefineSkippedError extends Error {
}
export interface AgentSessionConfig {
    agent: Agent;
    sessionManager: SessionManager;
    settingsManager: SettingsManager;
    serviceTierPreference?: ServiceTier;
    cwd: string;
    agentDir?: string;
    scopedModels?: Array<{
        model: Model<any>;
        thinkingLevel?: ThinkingLevel;
    }>;
    resourceLoader: ResourceLoader;
    customTools?: ToolDefinition[];
    modelRegistry: ModelRegistry;
    initialActiveToolNames?: string[];
    allowedToolNames?: string[];
    /**
     * Whether the built-in long-running goals feature is available: the bundled
     * goal skill in the Python kernel, its goal.* host handlers, and /goal.
     * Default: true.
     */
    includeGoals?: boolean;
    agentMessageController?: AgentSessionMessageController;
    agentObserveController?: AgentObserveController;
    /**
     * Whether the bundled compact skill and its compact.* host handlers are
     * available to the model. Default: the compaction.agentCallable setting.
     */
    includeCompactSkill?: boolean;
    /**
     * Optional host-side controller for the bundled rlm-heartbeat Python skill.
     * When omitted, rlm_heartbeat.* host requests are unavailable.
     */
    rlmHeartbeatController?: AgentRlmHeartbeatController;
    /**
     * Optional MCP integration manager. When present, its mcp.* host requests
     * (refresh, begin_login) are exposed to the kernel.
     */
    mcpManager?: McpManager;
    /**
     * Override base tools (useful for custom runtimes).
     *
     * These are synthesized into minimal ToolDefinitions internally so AgentSession can keep
     * a definition-first registry even when callers provide plain AgentTool instances.
     */
    baseToolsOverride?: Record<string, AgentTool>;
    extensionRunnerRef?: {
        current?: ExtensionRunner;
    };
    sessionStartEvent?: SessionStartEvent;
    rlmDepth?: number;
    rlmMaxDepth?: number;
    rlmSessionDir?: string;
    rlmParentNodeId?: string;
    rlmParentAgent?: string;
    subagentRuntimeHost?: SubagentRuntimeHost;
    autonomous?: AgentAutonomousConfig;
    prewarmIpythonKernel?: boolean;
    autoRefineReviewer?: AutoRefineReviewer;
    /**
     * When true, auto-refine runs synchronously between turns at the
     * shouldStopAfterTurn boundary instead of in the background after
     * agent_end. Used for print/headless autonomous runs so refinement
     * never overlaps the primary model request. Default: false.
     */
    serializedRefine?: boolean;
    /**
     * Initial goal to seed at session creation. Only applied when rlmDepth
     * is 0 and no persisted thread_goal_state entry exists in the branch.
     */
    initialGoal?: {
        objective: string;
        tokenBudget?: number;
    };
}
export interface ExtensionBindings {
    uiContext?: ExtensionUIContext;
    commandContextActions?: ExtensionCommandContextActions;
    shutdownHandler?: ShutdownHandler;
    onError?: ExtensionErrorListener;
}
export interface AutoRefineReviewRequest {
    reason: AutoRefineReason;
    turnsSinceLastReview: number;
}
/**
 * Discriminated result from a serialized-mode background planning pass.
 * - "plan": review approved and planning succeeded; carry the exact plan,
 *   options, and abort controller so the boundary can apply directly
 *   without a second planning request.
 * - "skip": reviewer declined; no refine needed.
 * - "failure": review or planning threw; boundary should not retry.
 */
export type SerializedBackgroundPlanResult = {
    status: "plan";
    plan: RefinementPlan;
    options: {
        instructions?: string;
        rollbackId?: string;
        global?: boolean;
    };
    abort: AbortController;
    branchVersion: number;
} | {
    status: "skip";
    explicit?: boolean;
} | {
    status: "invalidated";
    branchVersion: number;
} | {
    status: "failure";
    explicit: boolean;
    options: {
        instructions?: string;
        rollbackId?: string;
        global?: boolean;
    };
    branchVersion: number;
};
export type AutoRefineReviewer = (request: AutoRefineReviewRequest, signal?: AbortSignal) => Promise<AutoRefineReview>;
export interface PromptOptions {
    expandPromptTemplates?: boolean;
    images?: ImageContent[];
    streamingBehavior?: "steer" | "followUp";
    followUpQueueKey?: string;
    source?: InputSource;
    preflightResult?: (success: boolean, queued?: boolean) => void;
    queueIfBusy?: boolean;
    resumeIfIdle?: boolean;
    internalPrompt?: boolean;
    suppressAutonomousContinuation?: boolean;
    skipInputHandlers?: boolean;
    signal?: AbortSignal;
    admissionCommitted?: () => void;
    agentMessageId?: string;
    content?: (TextContent | ImageContent)[];
    customMessage?: CustomMessage;
}
type PreTurnCompactionTiming = "beforeModelSelection" | "afterModelSelection" | "skip";
type RefineBarrierPolicy = "always" | "ifInFlight" | "skip";
interface CommitPreparationPolicy {
    initialRefineBarrier: RefineBarrierPolicy;
    flushPendingBashBeforeValidation: boolean;
    validateModelAndAuth: boolean;
    awaitPendingModelSelection: boolean;
    preTurnCompaction: PreTurnCompactionTiming;
    finalRefineBarrier: RefineBarrierPolicy;
}
type QueuedAgentMessage = UserMessage | CustomMessage;
export interface TurnExecutionPolicy {
    preparation: CommitPreparationPolicy;
    runBeforeAgentStart: boolean;
    nextTurnContextTiming: "preparation" | "commit" | "skip";
    preserveEmptyExtensionPrompt: boolean;
    completionIncludesRetryChain: boolean;
}
export declare const SESSION_ACTION_RECOVERY_FORMAT_VERSION = 1;
export interface SessionActionRecoveryRecord {
    id: string;
    role: DeliveryRecord["role"];
    message: QueuedAgentMessage;
    ownerActionId: string;
}
export type SessionActionRecoveryPayload = {
    kind: "turn";
    text: string;
    preview?: string;
    records: SessionActionRecoveryRecord[];
    images?: ImageContent[];
    content?: (TextContent | ImageContent)[];
    customMessage?: CustomMessage;
    executionPolicy: TurnExecutionPolicy;
    queueVisible: boolean;
    acceptedAgentMessage: boolean;
    acceptedBeforeCompletion: boolean;
} | {
    kind: "session_command";
    text: string;
    command: SessionSlashCommand;
    images?: ImageContent[];
};
export interface SessionActionRecoveryAction {
    id: string;
    source: InputSource | "internal";
    delivery: DeliveryPolicy;
    wake: WakePolicy;
    payload: SessionActionRecoveryPayload;
    queueKey?: string;
    agentMessageId?: string;
    suppressAutonomousContinuation?: boolean;
}
export interface SessionActionRecoverySnapshot {
    formatVersion: typeof SESSION_ACTION_RECOVERY_FORMAT_VERSION;
    actions: SessionActionRecoveryAction[];
}
export interface ModelCycleResult {
    model: Model<any>;
    thinkingLevel: ThinkingLevel;
    serviceTier: ServiceTier;
    isScoped: boolean;
}
interface ModelSelectOptions {
    waitForExtensions?: boolean;
}
import type { RlmMaxDepthStatus, SetRlmMaxDepthResult } from "./rlm-max-depth.js";
export type { RlmMaxDepthSource, RlmMaxDepthStatus, SetRlmMaxDepthResult } from "./rlm-max-depth.js";
export declare function compactRlmText(text: string, maxLength?: number): string;
export declare function rlmChildLabel(prompt: string): string;
export declare class AgentSession {
    readonly agent: Agent;
    readonly sessionManager: SessionManager;
    readonly settingsManager: SettingsManager;
    private _serviceTierPreference;
    private _scopedModels;
    private _unsubscribeAgent?;
    private _eventListeners;
    private _lastSessionActionSnapshot;
    private _agentEventQueue;
    /** Session-owned actions. Items are never fed into Agent.steer/followUp. */
    private readonly _actionStore;
    private _sessionInputPump;
    private _sessionInputPumpRequested;
    private _sessionInputPumpEpoch;
    private _sessionInputArrivalEpoch;
    private _sessionInputPumpSuspended;
    private _sessionInputSuspendedForUpdateRestart;
    private readonly _queuedWorkPauses;
    private readonly _sessionInputAdmissionPauses;
    private readonly _durableRlmTerminalNoticeActionIds;
    private _sessionActionCommitTail;
    private _sessionActionCommitOwner;
    private _pendingSessionActionFenceWaiters;
    private readonly _sessionActionCommitContext;
    private readonly _sessionActionCommitDisposeAbortController;
    private readonly _sessionInputCheckpointWaiters;
    private _pendingNextTurnMessages;
    private _goalState;
    private _goalAccountingStartedAt;
    private _goalContinuationAwaitsRlmWork;
    private _goalAccountedAssistantMessages;
    private _goalAbortInProgress;
    private _autonomousState;
    private _autonomousContinuationSuppressionDepth;
    private _autonomousContinuationSuppressedMessages;
    private _compactionAbortController;
    private _autoCompactionAbortController;
    private _compactionOperation;
    /** One recovery attempt per overflow; "reported" dedups the failure notice. */
    private _overflowRecovery;
    private _continueAfterThresholdCompaction;
    private _pendingRequestedCompaction;
    private _pendingRequestedRefine;
    private _branchSummaryAbortController;
    private _branchSummaryOperation;
    private _retryAbortController;
    private _retryAttempt;
    private _retryPromise;
    private _retryResolve;
    private _retryAuthFailureSources;
    private _agentMessageClearEpoch;
    private _agentMessageOutcomes;
    private _lateIpythonSentAgentMessages;
    /** Outcome disclosures whose session-file append failed; retained for context rebuilds. */
    private readonly _unpersistedOutcomes;
    private _bashAbortControllers;
    private _userBashRunning;
    private _userBashAbortRequested;
    private _pendingBashMessages;
    private _extensionRunner;
    private _execEnvProvider?;
    private _turnIndex;
    private _modelSelectEmitQueue;
    private _modelSelectEmitQueueIdle;
    private _modelSelectEmitContext;
    private _resourceLoader;
    private _customTools;
    private _baseToolDefinitions;
    private _cwd;
    private _agentDir?;
    private _extensionRunnerRef?;
    private _initialActiveToolNames?;
    private _allowedToolNames?;
    private _includeGoals;
    private _includeCompactSkill;
    private _rlmHeartbeatController?;
    private _agentMessageController?;
    private _agentObserveController?;
    private _mcpManager?;
    private _baseToolsOverride?;
    private _sessionStartEvent;
    private _extensionUIContext?;
    private _extensionCommandContextActions?;
    private _extensionShutdownHandler?;
    private _extensionErrorListener?;
    private _extensionErrorUnsubscriber?;
    private _disposed;
    private readonly _disposeCallbacks;
    private _disposeCallbacksPromise?;
    private _disposing;
    private _disposeAsyncPromise?;
    private _ipythonKernelProvisioner?;
    /** Artifact dir backing the current provisioner's kernel snapshot, if any. */
    private _ipythonKernelSnapshotDir?;
    /** True once the runtime has been built once; later builds are in-process rebuilds (/reload). */
    private _ipythonRuntimeBuilt;
    private readonly _prewarmIpythonKernel;
    private _rlmDepth;
    private readonly _configuredRlmMaxDepth;
    private _rlmMaxDepth;
    private _rlmMaxDepthSource;
    private _rlmSessionDir?;
    private _rlmParentNodeId?;
    private _rlmParentAgent?;
    private _repliedToParentSinceTask;
    private _parentReplyCount;
    private _subagentRuntimeHost?;
    private _activeRlmChildRuns;
    private _unsettledRlmChildRuns;
    private _abandonedRlmQuiescenceChildIds;
    private _rlmQuiescenceWaitAborts;
    private _pendingRlmSubagentSessionNames;
    private _rlmChildSessions;
    private _deletedRlmChildIds;
    private _rlmChildCleanupFailures;
    private _deletingRlmChildren;
    private _rlmChildUnsubscribes;
    /** Latest recap for this session, written by the daemon summarizer; read by a parent to label its child snapshots. */
    private _currentRecap?;
    private _modelRegistry;
    private _toolRegistry;
    private _toolDefinitions;
    private _toolPromptSnippets;
    private _toolPromptGuidelines;
    private _baseSystemPrompt;
    private _baseSystemPromptOptions;
    private _assistantTurnsSinceAutoRefine;
    private _lastAutoRefineReviewAt;
    private _autoRefineInProgress;
    private readonly _autoRefineOperations;
    private readonly _scheduledAutoRefineTimers;
    private _compactAutoRefinePending;
    private _turnIntervalAutoRefinePending;
    private _postCompactionContinuationScheduled;
    private _postCompactionContinuationSettlement;
    private _postCompactionContinuationMessages;
    private _scheduledPostCompactionContinuationMessages;
    private _queuedAutonomousThresholdContinuations;
    private _queuedAutonomousContinuationSnapshots;
    private _pendingThresholdCompactionAutonomousMessages;
    private _queuedGoalThresholdContinuation;
    private _pendingAutoRefineReview;
    private _autoRefineBranchVersion;
    private _autoRefineReviewAbort?;
    private _refineAbortController?;
    private readonly _autoRefineReviewer?;
    private readonly _serializedRefine;
    private _refineInFlight?;
    private _refinePlanInFlight?;
    private _serializedPlanInFlight?;
    private _serializedPlanClaim?;
    private _serializedExplicitRefineOptions?;
    constructor(config: AgentSessionConfig);
    /** Refreshes MCP provider registrations without rebuilding the session runtime. */
    refreshMcpProviders(): void;
    /**
     * Set the RLM heartbeat controller after construction. Used by
     * print/headless mode to attach an in-process heartbeat scheduler
     * when the session is created outside the daemon.
     */
    setRlmHeartbeatController(controller: AgentRlmHeartbeatController): void;
    replaceAcpMcpServers(servers: readonly AcpMcpServerConfig[], ownerId: string): void;
    releaseAcpMcpServers(ownerId: string, serverNames: readonly string[]): Promise<void>;
    private _rebuildRuntimeForAcpMcpServers;
    get modelRegistry(): ModelRegistry;
    setSubagentRuntimeHost(host?: SubagentRuntimeHost): void;
    private _getRequiredRequestAuth;
    /**
     * Install tool hooks once on the Agent instance.
     *
     * The callbacks read `this._extensionRunner` at execution time, so extension reload swaps in the
     * new runner without reinstalling hooks. Extension-specific tool wrappers are still used to adapt
     * registered tool execution to the extension context. Tool call and tool result interception now
     * happens here instead of in wrappers.
     */
    private _installAgentToolHooks;
    private _installAgentContinuationHook;
    private _installAgentTurnHook;
    private _emit;
    private _emitQueueUpdate;
    private _restoreLateIpythonSentAgentMessages;
    private _rememberLateIpythonSentAgentMessage;
    private _applyLateIpythonSentAgentMessages;
    private _recordLateIpythonSentAgentMessage;
    private _emitGoalUpdate;
    private _loadPersistedRlmMaxDepthState;
    private _resolveRlmMaxDepth;
    private _loadPersistedGoalState;
    /**
     * Whether the session branch is seedable for an initial goal. Returns true
     * only when the branch contains exclusively bootstrap entry types
     * (model_change, thinking_level_change, service_tier_change) and no
     * thread_goal_state custom entry. Any message, custom entry, or persisted
     * goal (including cleared/complete/error) means the session has been used
     * and should not be reseeded.
     */
    private _isBranchSeedable;
    private _reloadGoalStateFromBranch;
    private _reloadRlmMaxDepthFromBranch;
    private _persistGoalState;
    private _setGoalState;
    private _goalWithCurrentWallClock;
    private _goalWithAccountedWallClock;
    private _cancelSessionActions;
    private _clearQueuedGoalContexts;
    private _startGoal;
    private _clearGoal;
    private _pauseGoal;
    private _resumeGoal;
    private _finishGoalWithError;
    private _finishGoalForTerminalAssistantMessage;
    private _stopGoalContinuationForTerminalMessage;
    private _parseGoalSlashCommand;
    private _parseAutonomousSlashCommand;
    private _formatAutonomousStatus;
    private _emitAutonomousStatus;
    private _handleAutonomousSlashCommand;
    private _appendBeforeAgentStartMessages;
    private _validateCanStartAgentRun;
    /**
     * Goals are pursued through the kernel goal skill, so the only tool the
     * model needs is ipython. Force-activate it (including into a live
     * continuation context) so the model can always reach `goal.complete()`.
     */
    private _ensureGoalRuntimeActive;
    private _maybeResumeGoalContinuationAfterRlmWork;
    private _runOrQueueGoalContext;
    private _handleGoalSlashCommand;
    private _accountGoalUsageForAssistantMessage;
    private get _steeringStopPending();
    private _shouldStopBeforeTurn;
    private _shouldStopAfterTurn;
    private _shouldStopForThresholdCompaction;
    private _runSerializedRefineCheckpoint;
    private _runSerializedRefineCheckpointAfterBackground;
    private _runSerializedAutoRefineReview;
    private _consumeSerializedBackgroundPlan;
    private _applySerializedPlan;
    /**
     * Start background refinement planning at assistant message_end, while
     * tools are still executing. The plan (if any) is awaited at the
     * shouldStopAfterTurn boundary before applying. Planning overlaps tool
     * execution only — never another model request.
     */
    private _maybeStartSerializedBackgroundPlan;
    private _runBackgroundPlan;
    private _runSerializedRefine;
    private _thresholdCompactionNeeded;
    private _snapshotAutonomousRuntimeState;
    private _restoreAutonomousRuntimeSnapshot;
    private _queueAutonomousContinuationForThresholdCompaction;
    private _queueGoalContinuationForThresholdCompaction;
    private _clearQueuedGoalContinuationAfterCancelledThresholdCompaction;
    private _clearQueuedAutonomousContinuations;
    private _clearQueuedAutonomousContinuationsAfterSkippedThresholdCompaction;
    /**
     * Handle a goal.* request from the Python kernel host bridge (the bundled
     * goal skill). All goal state stays host-side; the kernel only sees the
     * serialized snake_case response.
     */
    handleGoalHostRequest(type: string, payload?: Record<string, unknown>): GoalHostResponse;
    /**
     * Handle a compact.* request from the kernel host bridge. Compaction would
     * abort the run executing the requesting cell, so compact.run only schedules
     * it; _checkCompaction consumes the request at the turn boundary.
     */
    handleCompactHostRequest(type: string, payload?: Record<string, unknown>): Record<string, unknown>;
    /**
     * Handle a refine.* request from the kernel host bridge. Like compact,
     * refinement waits for the current turn to become idle before applying
     * changes, so refine.run only schedules it; _consumePendingRequestedRefine
     * fires it at the turn boundary. This prevents a deadlock that would occur
     * if refine() awaited agent idle from within the active tool call.
     */
    handleRefineHostRequest(type: string, payload?: Record<string, unknown>): Record<string, unknown>;
    /**
     * Handle an rlm_heartbeat.* request from the bundled rlm-heartbeat skill.
     * These heartbeats are internal to this active session and never read or
     * mutate the user-level /heartbeat.
     */
    handleRlmHeartbeatHostRequest(type: string, payload?: Record<string, unknown>): Record<string, unknown>;
    handleAgentMessageHostRequest(type: string, payload?: Record<string, unknown>): Promise<AgentSessionMessageListResult | AgentSessionMessageReceipt | AgentFamilyRosterResult> | AgentSessionMessageListResult | AgentFamilyRosterResult;
    handleAgentObserveHostRequest(type: string, payload?: Record<string, unknown>): AgentObserveListResult | AgentObserveAgentSnapshot | AgentObserveRecentMessagesResult | Promise<AgentObserveListResult | AgentObserveAgentSnapshot | AgentObserveRecentMessagesResult>;
    private _createGoalFromHost;
    private _completeGoalFromHost;
    private _getGoalContinuationMessages;
    private _getContinuationMessages;
    private _lastAssistantMessage;
    private _agentMessageOutcome;
    /**
     * Register a delivery waiter before submitting the prompt. Delivery outcomes are not retained
     * for late lookup, so callers that register after admission may wait for a future use of the id.
     */
    waitForAgentMessagePromptDelivery(agentMessageId: string): Promise<void>;
    private _settleAgentMessage;
    private _rejectAgentMessage;
    private _rejectQueuedAgentMessageDeliveries;
    private _capturingCancelledAction;
    private _hasCancelledDispatchCapture;
    private _handleAgentEvent;
    private _createRetryPromiseForAgentEnd;
    private _findLastAssistantInMessages;
    private _addLoginGuidanceToAuthError;
    private _processAgentEvent;
    private _resolveRetry;
    private _findLastAssistantMessage;
    private _replaceMessageInPlace;
    private _emitExtensionEvent;
    /**
     * Subscribe to agent events.
     * Session persistence is handled internally (saves messages on message_end).
     * Multiple listeners can be added. Returns unsubscribe function for this listener.
     */
    subscribe(listener: AgentSessionEventListener): () => void;
    /**
     * Temporarily disconnect from agent events.
     * User listeners are preserved and will receive events again after resubscribe().
     * Used internally during operations that need to pause event processing.
     */
    private _disconnectFromAgent;
    /**
     * Reconnect to agent events after _disconnectFromAgent().
     * Preserves all existing listeners.
     */
    private _reconnectToAgent;
    /**
     * Remove all listeners and disconnect from agent.
     * Call this when completely done with the session.
     */
    /**
     * Async teardown for graceful quit/switch: await the Python kernel's dispose
     * (which flushes a final namespace snapshot) before the synchronous dispose, so
     * the latest state reaches disk instead of racing process exit.
     */
    disposeAsync(): Promise<void>;
    private _drainPendingRefinementForDisposal;
    private _disposeAsyncOnce;
    private _startDisposeCallbacks;
    dispose(): void;
    registerDisposeCallback(callback: () => void | Promise<void>): void;
    get state(): AgentState;
    get model(): Model<any> | undefined;
    get thinkingLevel(): ThinkingLevel;
    get serviceTier(): ServiceTier;
    get isStreaming(): boolean;
    get systemPrompt(): string;
    get retryAttempt(): number;
    getActiveToolNames(): string[];
    getAllTools(): ToolInfo[];
    getToolDefinition(name: string): ToolDefinition | undefined;
    setActiveToolsByName(toolNames: string[]): void;
    get isCompacting(): boolean;
    get messages(): AgentMessage[];
    buildSessionContext(): SessionContext;
    private _mergeUnpersistedOutcomes;
    get steeringMode(): "all" | "one-at-a-time";
    get followUpMode(): "all" | "one-at-a-time";
    get sessionFile(): string | undefined;
    get sessionId(): string;
    get rlmDepth(): number;
    get rlmMaxDepth(): number;
    get sessionName(): string | undefined;
    get goalState(): GoalState;
    getAutonomousStatus(): AgentAutonomousStatus;
    recordHostAutonomousContinuation(): void;
    refreshAutonomousGates(): Promise<void>;
    private _runWithAutonomousContinuationSuppressed;
    private _markAutonomousContinuationSuppressed;
    get scopedModels(): ReadonlyArray<{
        model: Model<any>;
        thinkingLevel?: ThinkingLevel;
    }>;
    setScopedModels(scopedModels: Array<{
        model: Model<any>;
        thinkingLevel?: ThinkingLevel;
    }>): void;
    get promptTemplates(): ReadonlyArray<PromptTemplate>;
    private _normalizePromptSnippet;
    private _normalizePromptGuidelines;
    private _rebuildSystemPrompt;
    private _refreshExtensionSystemPrompt;
    private _finishSubmissionNormalization;
    private _normalizeSubmission;
    private _runPreTurnCompaction;
    private _prepareForCommit;
    private _applyPreparedSystemPrompt;
    private _canStartSessionActionImmediately;
    /**
     * Send a prompt to the agent.
     * - Handles extension commands (registered via pi.registerCommand) immediately, even during streaming
     * - Expands file-based prompt templates by default
     * - During streaming, queues via steer() or followUp() based on streamingBehavior option
     * - Validates model and API key before sending (when not streaming)
     * @throws Error if streaming and no streamingBehavior specified
     * @throws Error if no model selected or no API key available (when not streaming)
     */
    prompt(text: string, options?: PromptOptions): Promise<void>;
    promptUntilAccepted(text: string, options?: PromptOptions): Promise<void>;
    promptAndWait(text: string, options?: PromptOptions): Promise<void>;
    acceptAgentMessagePrompt(text: string, options?: PromptOptions): Promise<void>;
    queueAgentMessagePrompt(text: string, streamingBehavior: "steer" | "followUp", customMessage?: AgentSessionMessage): Promise<boolean>;
    promptHeartbeat(job: AgentCronJob, options?: PromptOptions): Promise<void>;
    private _isRlmTerminalNotice;
    private _assertRlmTerminalNotice;
    private _isRlmTerminalNoticeAction;
    private _hasDeferredRlmTerminalNotices;
    private _enqueueRlmTerminalNoticeAction;
    private _flushDeferredRlmTerminalNotices;
    private _acquireRlmTerminalNoticeRetentionFence;
    private _deferRlmTerminalNotice;
    private _demoteRlmTerminalNoticeActions;
    private _promptInjectedMessage;
    private _prompt;
    private _executeExtensionCommand;
    /**
     * Expand skill commands (/skill:name args) to their full content.
     * Returns the expanded text, or the original text if not a skill command or skill not found.
     * Emits errors via extension runner if file read fails.
     */
    private _expandSkillCommand;
    /**
     * Queue a steering message while the agent is running.
     * Delivered after the current assistant turn finishes executing its tool calls,
     * before the next LLM call.
     * Expands skill commands and prompt templates. Errors on extension commands.
     * @param images Optional image attachments to include with the message
     * @throws Error if text is an extension command
     */
    steer(text: string, images?: ImageContent[], options?: {
        queueKey?: string;
        agentMessageId?: string;
        resumeIfIdle?: boolean;
    }): Promise<void>;
    /**
     * Queue a follow-up message to be processed after the agent finishes.
     * Delivered only when agent has no more tool calls or steering messages.
     * Expands skill commands and prompt templates. Errors on extension commands.
     * @param images Optional image attachments to include with the message
     * @throws Error if text is an extension command
     */
    followUp(text: string, images?: ImageContent[], options?: {
        queueKey?: string;
        agentMessageId?: string;
        resumeIfIdle?: boolean;
    }): Promise<boolean>;
    restoreSessionActions(snapshot: SessionActionRecoverySnapshot): Promise<number>;
    private _restoreSessionCommand;
    private _restorePromptInput;
    restoreSteeringMessage(text: string, images?: ImageContent[], options?: {
        queueKey?: string;
        agentMessageId?: string;
        content?: (TextContent | ImageContent)[];
        customMessage?: CustomMessage;
        prefixMessages?: CustomMessage[];
    }): Promise<void>;
    restoreFollowUpMessage(text: string, images?: ImageContent[], options?: {
        queueKey?: string;
        agentMessageId?: string;
        content?: (TextContent | ImageContent)[];
        customMessage?: CustomMessage;
        prefixMessages?: CustomMessage[];
    }): Promise<boolean>;
    private _buildPromptContent;
    private _takePendingNextTurnMessages;
    private _deliveryPolicy;
    private _createDeliveryRecord;
    private _turnExecutionPolicy;
    private _createPreparedTurnAction;
    private _createSessionCommandAction;
    private _coalescedFollowUpOwner;
    private _assertSessionActionAdmissionAvailable;
    private _admitSessionInput;
    private _queuePreparedPrompt;
    private _runtimeActivity;
    private _hasSelectableSessionInput;
    get hasPendingSessionWork(): boolean;
    get hasPendingAdmissionWaiters(): boolean;
    private _scheduleSessionInputPump;
    private _pumpSessionInputs;
    private _executeSelectedSessionCommand;
    private _isBusyForSessionInput;
    private _isSessionInputHandoffDeferred;
    private _asError;
    private _isDeferredSessionInputError;
    private _surfaceSessionInputError;
    private _startPreparedTurnActions;
    private _executeQueuedSessionCommand;
    private _appendDurableSessionCommandMessage;
    private _throwIfExtensionCommand;
    /**
     * Send a custom message to the session. Creates a CustomMessageEntry.
     *
     * Handles three cases:
     * - Streaming: queues message, processed when loop pulls from queue
     * - Not streaming + triggerTurn: appends to state/session, starts new turn
     * - Not streaming + no trigger: appends to state/session, no turn
     *
     * @param message Custom message with customType, content, display, details
     * @param options.triggerTurn If true and not streaming, triggers a new LLM turn
     * @param options.deliverAs Delivery mode: "steer", "followUp", or "nextTurn"
     */
    sendCustomMessage<T = unknown>(message: Pick<CustomMessage<T>, "customType" | "content" | "display" | "details">, options?: {
        triggerTurn?: boolean;
        deliverAs?: "steer" | "followUp" | "nextTurn";
    }): Promise<void>;
    /**
     * Send a user message to the agent. Always triggers a turn.
     * When the agent is streaming, use deliverAs to specify how to queue the message.
     *
     * @param content User message content (string or content array)
     * @param options.deliverAs Delivery mode when streaming: "steer" or "followUp"
     */
    sendUserMessage(content: string | (TextContent | ImageContent)[], options?: {
        deliverAs?: "steer" | "followUp";
    }): Promise<void>;
    clearQueue(): {
        steering: string[];
        followUp: string[];
    };
    private _invalidateQueuedPromptPreparation;
    clearQueuedAgentMessages(): {
        steering: string[];
        followUp: string[];
    };
    clearQueuedUserMessagesMatching(predicate: (text: string) => boolean): {
        steering: string[];
        followUp: string[];
    };
    /**
     * Mutate a single visible queued message, addressed by its position in the same
     * projection the session-action snapshot publishes. expectedText must match the
     * item's current preview so clients never edit a shifted queue by accident.
     */
    mutateQueuedMessage(lane: QueuedMessageLane, index: number, expectedText: string, mutation: QueuedMessageMutation): QueuedMessageMutationStatus;
    get queuedActionCount(): number;
    get unfinishedActionCount(): number;
    get isQueuedWorkSuspended(): boolean;
    get isSessionActive(): boolean;
    getSessionActionSnapshot(): SessionActionSnapshot;
    getSteeringMessages(): readonly string[];
    getSteeringMessagePreviews(): readonly string[];
    getFollowUpMessages(): readonly string[];
    getFollowUpMessagePreviews(): readonly string[];
    getSessionActionRecoverySnapshot(): SessionActionRecoverySnapshot;
    private _notifySessionInputCheckpointChange;
    private _waitForSessionActivityChange;
    private _observeSessionActionDeferral;
    waitForSessionInputCheckpoint(signal?: AbortSignal): Promise<void>;
    acquireSessionInputPause(): {
        release(): void;
    };
    acquireQueuedWorkPause(): {
        release(): void;
    };
    private _acquireDirectTurnAdmissionFence;
    private _acquireSessionActionCommitFence;
    private _resumeSessionInputAdmission;
    /** Resume the scheduler after requestAbort/abortForUpdateRestart suspended it; owned pause leases are unaffected. */
    resumeQueuedWork(): boolean;
    waitForSessionInputIdle(): Promise<void>;
    waitForIdle(): Promise<void>;
    private _waitForIdleOrSettlement;
    /** Waits out any owned post-compaction continuation and rejects when one cannot start; {@link waitForIdle} never rejects. */
    waitForHeadlessIdle(): Promise<void>;
    getPendingNextTurnMessageSnapshots(): readonly CustomMessage[];
    restorePendingNextTurnMessages(messages: readonly CustomMessage[]): void;
    removeQueuedFollowUp(queueKey: string): boolean;
    get resourceLoader(): ResourceLoader;
    requestAbort(): void;
    abort(): Promise<void>;
    abortForUpdateRestart(): void;
    private _emitModelSelect;
    private _queueModelSelectEmit;
    setModel(model: Model<any>, options?: ModelSelectOptions): Promise<void>;
    private _trackModelSelectEmitError;
    private _shouldWaitForModelSelectEmit;
    private _pendingModelSelectEmit;
    cycleModel(direction?: "forward" | "backward", options?: ModelSelectOptions): Promise<ModelCycleResult | undefined>;
    private _cycleScopedModel;
    private _cycleAvailableModel;
    setThinkingLevel(level: ThinkingLevel): void;
    setServiceTier(serviceTier: ServiceTier): void;
    private _getEffectiveServiceTier;
    private _getServiceTierForModelSwitch;
    private _clampServiceTierForModel;
    cycleThinkingLevel(): ThinkingLevel | undefined;
    getAvailableThinkingLevels(): ThinkingLevel[];
    supportsThinking(): boolean;
    private _getThinkingLevelForModelSwitch;
    private _clampThinkingLevel;
    private _syncKernelStateAfterCompaction;
    private _onIpythonStateRestored;
    setSteeringMode(mode: "all" | "one-at-a-time"): void;
    setFollowUpMode(mode: "all" | "one-at-a-time"): void;
    compact(customInstructions?: string, options?: {
        skipAbort?: boolean;
    }): Promise<CompactionResult>;
    private _performCompaction;
    private _reapDeletedRlmSubagentRuntimesAfterCompaction;
    abortCompaction(): void;
    private _localHarnessStateDir;
    private _autoRefineAllowedForSession;
    private _settlePostCompactionContinue;
    private _cancelPostCompactionContinue;
    private _discardPendingAutoRefine;
    private _invalidatePendingAutoRefineForBranchChange;
    /**
     * Consume a refine request that was scheduled by the agent-callable refine
     * skill (refine.run). Fire-and-forget: the refine() method handles its own
     * background planning, idle wait, application, and error recovery. Called
     * at the turn boundary after compaction checks and before auto-refine
     * scheduling so the manual request takes priority.
     */
    private _emitRefineFailed;
    private _consumePendingRequestedRefine;
    private _scheduleAutoRefineAfterAgentEnd;
    private _scheduleAutoRefineAfterCompaction;
    private _schedulePostCompactionContinue;
    private _sessionOwnsScheduledContinuations;
    private _waitForQueuedWorkResume;
    private _runScheduledPostCompactionContinue;
    private _forgetConsumedPostCompactionContinuations;
    private _shouldSkipAutoRefineForActiveAgent;
    private _scheduleDeferredAutoRefineIfIdle;
    private _scheduleAutoRefine;
    private _maybeAutoRefine;
    private _runApprovedRefine;
    private _reviewAutoRefine;
    /** Global harness state overlaid with this session's local state, when persisted. */
    private _loadMergedHarnessState;
    private _loadRefinementHistory;
    /**
     * Refine editable continual harness state: prompt notes, memory, skills, and subagent specs.
     * The base system prompt is intentionally not editable through this path.
     *
     * Planning runs in the background and does NOT block turn entry points
     * (`_waitForRefineIdle` only waits for `_refineInFlight`). Only the fast
     * application phase (disk I/O + in-memory mutation) blocks turn entry points.
     */
    refine(options?: {
        instructions?: string;
        rollbackId?: string;
        global?: boolean;
    }, internal?: {
        skipAbort?: boolean;
        trigger?: "manual" | "auto";
    }): Promise<RefinementResult>;
    private _waitForRefineIdle;
    private _planRefine;
    private _recordRefinementOutcome;
    private _applyRefine;
    abortBranchSummary(): void;
    /**
     * Check if compaction is needed and run it.
     * Called after agent_end and before prompt submission.
     *
     * Two cases:
     * 1. Overflow: LLM returned context overflow error, remove error message from agent state, compact, auto-retry
     * 2. Threshold: Context over threshold, compact, and continue only for stopped in-progress loops or queued messages
     *
     * @param assistantMessage The assistant message to check
     * @param skipAbortedCheck If false, include aborted messages (for pre-prompt check). Default: true
     */
    private _getThresholdContextTokens;
    private _checkCompaction;
    /**
     * Internal: Run automatic (threshold/overflow) or model-requested compaction
     * with events.
     */
    private _endCompactionUnsuccessfully;
    private _persistCompactionOutcome;
    private _runAutoCompaction;
    setAutoCompactionEnabled(enabled: boolean): void;
    get autoCompactionEnabled(): boolean;
    /**
     * Set the provider for extra env vars merged over process.env in extension
     * pi.exec() subprocesses. The function is read at exec time, so a host (e.g.
     * the daemon) can update the underlying value per attach without rebinding.
     */
    setExecEnvProvider(provider: (() => Record<string, string | undefined> | undefined) | undefined): void;
    bindExtensions(bindings: ExtensionBindings): Promise<void>;
    private extendResourcesFromExtensions;
    private buildExtensionResourcePaths;
    private getExtensionSourceLabel;
    private _applyExtensionBindings;
    private _refreshCurrentModelFromRegistry;
    private _bindExtensionCore;
    private _refreshToolRegistry;
    private _buildRuntime;
    /**
     * Skills exposed to the model (system prompt + kernel). The bundled goal
     * and compact skills are withheld when disabled for this session.
     */
    private _modelVisibleSkills;
    private _createKernelHostHandlers;
    reload(): Promise<void>;
    private _rlmKernelEnv;
    private _addWebsearchKeyEnv;
    private _ensureRlmSessionDir;
    private _createChildRlmSessionDir;
    private _createEphemeralRlmSessionDir;
    _contextTokensForCurrentMessages(): number | undefined;
    setCurrentRecap(recap: string | undefined): void;
    get repliedToParentSinceTask(): boolean | undefined;
    getCurrentRecap(): string | undefined;
    private _findAssistantEntryForMessage;
    private _createRlmSubagentRuntimeOptions;
    private _createRlmSubagentRuntime;
    private _createInlineRlmSubagentRuntime;
    private _abandonRlmRunForQuiescence;
    private _cancelActiveRlmChildRuns;
    private _cancelRlmChildRun;
    getRlmChildRunStatus(childId: string): RlmChildAgentStatus | undefined;
    private _currentActiveSessionId;
    private _awaitPendingRlmChildPublication;
    listRlmSubagents(): Promise<RlmListSubagentsResult>;
    private _buildRlmSubagentList;
    private _rlmSubagentMatchesTarget;
    private _resolveDirectRlmSubagent;
    deleteInactiveRlmSubagent(childId: string, isExternallyRunning?: () => boolean): Promise<"deleted" | "not_found" | "running">;
    deleteRlmSubagent(target: string): Promise<RlmDeleteSubagentResult>;
    private _trackRlmSubagentDeletion;
    private _deleteRlmSubagentSession;
    private _ensureRlmRunDeletionCleanup;
    private _recordRlmRunDeletionCleanupFailure;
    private _finishRlmRunDeletion;
    private _observeRlmRunDeletionCleanup;
    private _continueFinishedRlmRunDeletion;
    private _removeRlmSubagentTracking;
    private _emitRlmSubagentRemoval;
    private _deleteResolvedRlmSubagent;
    /**
     * Retain a finished child session for the parent lifetime so inspectors and
     * daemon-hosted agent messaging can keep addressing it. Returns false (and disposes
     * the child) when the parent is already tearing down, so the caller can drop the
     * matching event forwarder too.
     */
    registerRlmChildSession(childId: string, session: AgentSession, unsubscribe?: () => void): boolean;
    releaseRlmChildSession(childId: string, session: AgentSession): (() => void) | false;
    private _rlmChildSnapshotForRun;
    private _rlmChildSnapshotForSession;
    /** Live recursive child roster from lifecycle state, including nested work under retained parents. */
    getRlmChildSnapshots(): RlmChildAgentSnapshot[];
    /** True when any direct or nested subagent is still running or queued. */
    hasRunningRlmChildren(): boolean;
    private _rlmChildSessionSnapshot;
    private _hasUnsettledRlmQuiescenceWork;
    /**
     * Wait for every admitted descendant run to publish its terminal parent
     * message and for the resulting parent turns to drain. Re-snapshotting after
     * each drain includes descendants spawned while earlier results were consumed.
     */
    waitForRlmQuiescence(externalSignal?: AbortSignal): Promise<void>;
    getRlmChildSession(childId: string): AgentSession | undefined;
    /**
     * Cancel a single RLM child run by id, searching nested child sessions.
     *
     * @returns true when a live run was cancelled or its unsettled terminal notice
     * was suppressed; false when the id is unknown or the run already settled.
     */
    cancelRlmChildRun(childId: string, reason?: string): boolean;
    private _assertRlmSubagentSessionNameAvailable;
    private _authenticatedRlmModels;
    findRlmModels(query: string, limit: number): Promise<RlmFindModelsResult>;
    private _resolveRlmSubagentModel;
    private _startRlmChildRun;
    runRlmChild(prompt: string, kwargs?: Record<string, unknown>, spawnCode?: string): Promise<RlmSpawnHandle>;
    private _isRetryableError;
    private _isFauxProviderQueueExhausted;
    private _isAgentLifecycleFailure;
    private _getProviderStreamFailureDetails;
    private _getProviderStreamFailureKind;
    private _isStructuredPermanentProviderFailure;
    private _isStructuredPermanentProviderRetryExhausted;
    private _getProviderStreamFailureAuthStatus;
    private _isConcreteProviderAuthFailure;
    private _captureRetryAuthFailureSource;
    private _markProviderAuthStale;
    private _markProviderAuthStaleForRetryFailure;
    private _finishActiveRetryWithFailure;
    private _handleRetryableError;
    abortRetry(): void;
    private waitForRetry;
    get isRetrying(): boolean;
    get hasAcceptedPromptInFlight(): boolean;
    get autoRetryEnabled(): boolean;
    setAutoRetryEnabled(enabled: boolean): void;
    /**
     * Execute a bash command.
     * Adds result to agent context and session.
     * @param command The bash command to execute
     * @param onChunk Optional streaming callback for output
     * @param options.excludeFromContext If true, command output won't be sent to LLM (!! prefix)
     * @param options.operations Custom BashOperations for remote execution
     */
    executeBash(command: string, onChunk?: (chunk: string) => void, options?: {
        excludeFromContext?: boolean;
        operations?: BashOperations;
        transient?: boolean;
    }): Promise<BashResult>;
    /**
     * Run a user-initiated bash command (! / !! prefix), emitting bash_start,
     * bash_output, and bash_end session events so any attached client can render
     * streaming output. Extensions can intercept execution via the user_bash event.
     * Execution failures are reported through bash_end rather than a rejected promise;
     * only the already-running guard and extension dispatch errors reject.
     * @param command The bash command to execute
     * @param options.excludeFromContext If true, command output won't be sent to LLM (!! prefix)
     */
    runUserBash(command: string, options?: {
        excludeFromContext?: boolean;
        transient?: boolean;
        runId?: string;
    }): Promise<void>;
    private _drainQueuedMessagesAfterBash;
    private runUserBashLocked;
    recordBashResult(command: string, result: BashResult, options?: {
        excludeFromContext?: boolean;
    }): void;
    /**
     * Cancel running bash command.
     */
    abortBash(): void;
    get isBashRunning(): boolean;
    /** Whether there are pending bash messages waiting to be flushed */
    get hasPendingBashMessages(): boolean;
    /**
     * Flush pending bash messages to agent state and session.
     * Called after agent turn completes to maintain proper message ordering.
     */
    private _flushPendingBashMessages;
    getRlmMaxDepthStatus(): RlmMaxDepthStatus;
    setRlmMaxDepth(maxDepth: number, options?: {
        global?: boolean;
    }): Promise<SetRlmMaxDepthResult>;
    setSessionName(name: string): void;
    /**
     * Navigate to a different node in the session tree.
     * Unlike fork() which creates a new session file, this stays in the same file.
     *
     * @param targetId The entry ID to navigate to
     * @param options.summarize Whether user wants to summarize abandoned branch
     * @param options.customInstructions Custom instructions for summarizer
     * @param options.replaceInstructions If true, customInstructions replaces the default prompt
     * @param options.label Label to attach to the branch summary entry
     * @returns Result with editorText (if user message) and cancelled status
     */
    private _branchNavigationQueue;
    navigateTree(targetId: string, options?: {
        summarize?: boolean;
        customInstructions?: string;
        replaceInstructions?: boolean;
        label?: string;
    }): Promise<{
        editorText?: string;
        cancelled: boolean;
        aborted?: boolean;
        summaryEntry?: BranchSummaryEntry;
    }>;
    private _navigateTree;
    private _navigateTreeUnderPause;
    getUserMessagesForForking(): Array<{
        entryId: string;
        text: string;
    }>;
    private _extractUserMessageText;
    getSessionStats(): SessionStats;
    getContextUsage(): ContextUsage | undefined;
    private _rlmSessionDirForReading;
    private _contextWindowResolver;
    /**
     * Build the agent context overview for /context: this session as the root
     * plus one node per RLM sub-agent, recursively. Running children are read
     * from their live sessions; completed children from their persisted session
     * dirs, so the tree survives child disposal and session resume.
     */
    getContextTree(): ContextTreeNode;
    /**
     * Export session to HTML.
     * @param outputPath Optional output path (defaults to session directory)
     * @returns Path to exported file
     */
    exportToHtml(outputPath?: string): Promise<string>;
    /**
     * Export the current session branch to a JSONL file.
     * Writes the session header followed by all entries on the current branch path.
     * @param outputPath Target file path. If omitted, generates a timestamped file in cwd.
     * @returns The resolved output file path.
     */
    exportToJsonl(outputPath?: string): string;
    /**
     * Get text content of last assistant message.
     * Useful for /copy command.
     * @returns Text content, or undefined if no assistant message exists
     */
    getLastAssistantText(): string | undefined;
    createReplacedSessionContext(): ReplacedSessionContext;
    hasExtensionHandlers(eventType: string): boolean;
    get extensionRunner(): ExtensionRunner;
}
//# sourceMappingURL=agent-session.d.ts.map