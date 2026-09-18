import type { AgentConnectionSessionEvent } from "../agent-connection/index.js";
export type AgentActivity = "waiting" | "thinking" | "writing" | "writing-code" | "executing";
export interface AgentActivityStatus {
    activity: AgentActivity;
    direction: "down" | "up";
    tokens: number;
}
export declare const AGENT_ACTIVITY_LABELS: Record<AgentActivity, string>;
export declare class AgentActivityTracker {
    private activity;
    private completedTokens;
    private streamingUsageTokens;
    private streamingChars;
    private runningToolCount;
    private reportedTokens;
    handleEvent(event: AgentConnectionSessionEvent): void;
    getStatus(): AgentActivityStatus;
    private currentTokens;
    reset(): void;
    private estimatedStreamingTokens;
}
export declare function formatTokenCount(count: number): string;
//# sourceMappingURL=agent-activity.d.ts.map