import type { AgentConnectionSessionEvent } from "../agent-connection/types.js";
import type { PrimeAgentSessionMeta } from "./acp-meta.js";
/**
 * Translate prime-agent session events into ACP `session/update` payloads.
 *
 * Kept as a pure function so the mapping is testable without a live ACP client
 * or a running agent. Returning an array lets one prime-agent event fan out to
 * several ACP updates (or none, for events ACP has no place for).
 */
export type AcpToolKind = "read" | "edit" | "delete" | "move" | "search" | "execute" | "think" | "fetch" | "other";
export type AcpToolStatus = "pending" | "in_progress" | "completed" | "failed";
export interface AcpSessionUpdate {
    sessionUpdate: string;
    [key: string]: unknown;
}
/** prime-agent's model-facing tool is the Python REPL; bash is the secondary escape hatch. */
export declare const IPYTHON_TOOL_NAME = "ipython";
export declare function acpToolKind(toolName: string): AcpToolKind;
/** Correlates streamed bash output and assistant chunks with their owning run or message. */
export interface AcpEventMappingState {
    activeBashRunId?: string;
    activeAssistantMessageId?: string;
    nextAssistantMessageSequence?: number;
}
export declare function acpUpdatesForSessionEvent(event: AgentConnectionSessionEvent, state?: AcpEventMappingState): AcpSessionUpdate[];
export declare function bashToolCallId(runId: string | undefined): string;
export type { PrimeAgentSessionMeta };
//# sourceMappingURL=acp-events.d.ts.map