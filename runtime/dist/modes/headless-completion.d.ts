import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { AgentSession } from "../core/agent-session.js";
import { type AgentAutonomousStatus } from "../core/autonomous.js";
import { type CompactionOutcomeMessage, type SessionSlashCommandResultMessage } from "../core/messages.js";
export declare function latestAutonomousGateAttempt(status: AgentAutonomousStatus): number;
export type HeadlessTerminalResultMessage = AssistantMessage | SessionSlashCommandResultMessage;
export interface HeadlessTerminalResult {
    primary?: HeadlessTerminalResultMessage;
    compactionOutcomes: CompactionOutcomeMessage[];
}
export declare function selectHeadlessTerminalResult(messages: readonly AgentMessage[]): HeadlessTerminalResult;
export interface HeadlessCompletionOptions {
    /** Include descendant settlement and the parent turns caused by their results. */
    waitForRlmQuiescence?: boolean;
}
export declare function waitForHeadlessCompletion(session: AgentSession, options?: HeadlessCompletionOptions): Promise<AgentAutonomousStatus>;
//# sourceMappingURL=headless-completion.d.ts.map