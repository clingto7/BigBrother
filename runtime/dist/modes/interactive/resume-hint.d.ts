import type { SessionStats } from "../../core/session-stats.js";
export type ResumeHintStats = Pick<SessionStats, "sessionId" | "sessionFile" | "userMessages">;
/** Omit ephemeral and unflushed empty sessions because neither can be resumed. */
export declare function formatResumeHint(stats: ResumeHintStats | undefined): string | undefined;
//# sourceMappingURL=resume-hint.d.ts.map