import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ToolResultMessage } from "@earendil-works/pi-ai";
export interface FileChangeSummary {
    path: string;
    added: number;
    removed: number;
}
export declare function countChangedLines(diff: string): {
    added: number;
    removed: number;
};
export declare function getToolFileChanges(toolName: string, args: unknown, result: {
    details?: unknown;
    isError: boolean;
}, cwd: string): FileChangeSummary[];
export declare function mergeTurnFileChanges(target: Map<string, FileChangeSummary>, message: AgentMessage, toolResults: readonly ToolResultMessage[], cwd: string): void;
/** Indent that aligns diff rows with the summary line's text column. */
export declare const FILE_CHANGE_DIFF_INDENT: string;
/**
 * One `    ╰─ <path> +N -M` row, truncated to width; the path renders relative
 * to cwd where possible and the hint renders only when diffsExpanded is defined.
 */
export declare function formatFileChangeSummaryLine(rawPath: string, cwd: string | undefined, change: Pick<FileChangeSummary, "added" | "removed">, diffsExpanded: boolean | undefined, width: number): string;
export declare function formatTotalChangeSummary(changes: readonly FileChangeSummary[]): string;
//# sourceMappingURL=edit-summary.d.ts.map