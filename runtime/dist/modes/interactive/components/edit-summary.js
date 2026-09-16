import { isAbsolute } from "node:path";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { generateDiffString } from "../../../core/tools/edit-diff.js";
import { resolveToCwd } from "../../../core/tools/path-utils.js";
import { canonicalizePath, formatPathRelativeToCwdOrAbsolute } from "../../../utils/paths.js";
import { theme } from "../theme/theme.js";
import { expandCollapseHint } from "./keybinding-hints.js";
export function countChangedLines(diff) {
    let added = 0;
    let removed = 0;
    for (const line of diff.split("\n")) {
        if (line.startsWith("+"))
            added++;
        else if (line.startsWith("-"))
            removed++;
    }
    return { added, removed };
}
function mergeFileChange(target, change, cwd) {
    if (change.added === 0 && change.removed === 0)
        return;
    const key = canonicalizePath(resolveToCwd(change.path, cwd));
    const existing = target.get(key);
    if (existing) {
        existing.added += change.added;
        existing.removed += change.removed;
    }
    else {
        target.set(key, { ...change });
    }
}
export function getToolFileChanges(toolName, args, result, cwd) {
    const changes = new Map();
    if (toolName === "ipython") {
        for (const display of result.details?.diffs ?? []) {
            const { diff } = generateDiffString(display.oldStr, display.newStr, 4, display.startLine ?? 1);
            mergeFileChange(changes, { path: display.path, ...countChangedLines(diff) }, cwd);
        }
    }
    else if (toolName === "edit" && !result.isError) {
        const editArgs = args;
        const path = typeof editArgs?.path === "string" ? editArgs.path : editArgs?.file_path;
        const diff = result.details?.diff;
        if (typeof path === "string" && diff) {
            mergeFileChange(changes, { path, ...countChangedLines(diff) }, cwd);
        }
    }
    return [...changes.values()];
}
export function mergeTurnFileChanges(target, message, toolResults, cwd) {
    if (message.role !== "assistant")
        return;
    const calls = new Map(message.content.filter((content) => content.type === "toolCall").map((content) => [content.id, content]));
    for (const result of toolResults) {
        const call = calls.get(result.toolCallId);
        if (!call)
            continue;
        for (const change of getToolFileChanges(call.name, call.arguments, result, cwd)) {
            mergeFileChange(target, change, cwd);
        }
    }
}
/** Dim gutter that anchors every per-file change summary line. */
const FILE_CHANGE_SUMMARY_PREFIX = "    ╰─ ";
/** Indent that aligns diff rows with the summary line's text column. */
export const FILE_CHANGE_DIFF_INDENT = " ".repeat(visibleWidth(FILE_CHANGE_SUMMARY_PREFIX));
function formatChangeCounts(change) {
    return `${theme.fg("toolDiffAdded", `+${change.added}`)} ${theme.fg("toolDiffRemoved", `-${change.removed}`)}`;
}
function formatFileChangePath(path, cwd) {
    const resolvedPath = resolveToCwd(path, cwd);
    const lexicalPath = formatPathRelativeToCwdOrAbsolute(resolvedPath, cwd);
    if (!isAbsolute(lexicalPath))
        return lexicalPath;
    return formatPathRelativeToCwdOrAbsolute(canonicalizePath(resolvedPath), canonicalizePath(cwd));
}
/**
 * One `    ╰─ <path> +N -M` row, truncated to width; the path renders relative
 * to cwd where possible and the hint renders only when diffsExpanded is defined.
 */
export function formatFileChangeSummaryLine(rawPath, cwd, change, diffsExpanded, width) {
    const prefix = theme.fg("dim", FILE_CHANGE_SUMMARY_PREFIX);
    const hint = diffsExpanded === undefined
        ? ""
        : `${theme.fg("dim", " · ")}${expandCollapseHint("app.edits.expand", diffsExpanded)}`;
    // Size the path against the wider hint variant ("to collapse") so toggling
    // ctrl+j never re-truncates it — the summary line is a stable anchor.
    const widestHint = diffsExpanded === undefined ? "" : `${theme.fg("dim", " · ")}${expandCollapseHint("app.edits.expand", true)}`;
    const counts = `${theme.fg("dim", " ")}${formatChangeCounts(change)}`;
    const suffix = `${counts}${hint}`;
    const safeWidth = Math.max(1, width);
    const available = Math.max(1, safeWidth - visibleWidth(prefix) - visibleWidth(counts) - visibleWidth(widestHint));
    const displayPath = cwd === undefined ? rawPath : formatFileChangePath(rawPath, cwd);
    const path = truncateToWidth(displayPath, available, "…");
    return truncateToWidth(`${prefix}${theme.fg("muted", path)}${suffix}`, safeWidth, "");
}
export function formatTotalChangeSummary(changes) {
    const totals = changes.reduce((sum, change) => ({ added: sum.added + change.added, removed: sum.removed + change.removed }), { added: 0, removed: 0 });
    const files = `${changes.length} file${changes.length === 1 ? "" : "s"} changed`;
    return `${theme.fg("muted", files)}${theme.fg("dim", " | ")}${formatChangeCounts(totals)}`;
}
//# sourceMappingURL=edit-summary.js.map