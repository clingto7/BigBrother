/**
 * Branch summarization for tree navigation.
 *
 * When navigating to a different point in the session tree, this generates
 * a summary of the branch being left so context isn't lost.
 */
import { completeSimple } from "@earendil-works/pi-ai";
import { convertToLlm, createBranchSummaryMessage, createCompactionSummaryMessage, createCustomMessage, } from "../messages.js";
import { estimateTokens } from "./compaction.js";
import { computeFileLists, createFileOps, extractFileOpsFromMessage, formatFileOperations, SUMMARIZATION_SYSTEM_PROMPT, serializeConversation, } from "./utils.js";
/**
 * Collect entries that should be summarized when navigating from one position to another.
 *
 * Walks from oldLeafId back to the common ancestor with targetId, collecting entries
 * along the way. Does NOT stop at compaction boundaries - those are included and their
 * summaries become context.
 *
 * @param session - Session manager (read-only access)
 * @param oldLeafId - Current position (where we're navigating from)
 * @param targetId - Target position (where we're navigating to)
 * @returns Entries to summarize and the common ancestor
 */
export function collectEntriesForBranchSummary(session, oldLeafId, targetId) {
    if (!oldLeafId) {
        return { entries: [], commonAncestorId: null };
    }
    const oldPath = new Set(session.getBranch(oldLeafId).map((e) => e.id));
    const targetPath = session.getBranch(targetId);
    let commonAncestorId = null;
    for (let i = targetPath.length - 1; i >= 0; i--) {
        if (oldPath.has(targetPath[i].id)) {
            commonAncestorId = targetPath[i].id;
            break;
        }
    }
    const entries = [];
    let current = oldLeafId;
    while (current && current !== commonAncestorId) {
        const entry = session.getEntry(current);
        if (!entry)
            break;
        entries.push(entry);
        current = entry.parentId;
    }
    entries.reverse();
    return { entries, commonAncestorId };
}
/**
 * Extract AgentMessage from a session entry.
 * Similar to getMessageFromEntry in compaction.ts but also handles compaction entries.
 */
function getMessageFromEntry(entry) {
    switch (entry.type) {
        case "message":
            // Tool-result context remains attached to its assistant tool call.
            if (entry.message.role === "toolResult")
                return undefined;
            return entry.message;
        case "custom_message":
            return createCustomMessage(entry.customType, entry.content, entry.display, entry.details, entry.timestamp);
        case "branch_summary":
            return createBranchSummaryMessage(entry.summary, entry.fromId, entry.timestamp);
        case "compaction":
            return createCompactionSummaryMessage(entry.summary, entry.tokensBefore, entry.timestamp, entry.customInstructions);
        case "thinking_level_change":
        case "model_change":
        case "custom":
        case "label":
        case "session_info":
            return undefined;
    }
}
/**
 * Prepare entries for summarization with token budget.
 *
 * Walks entries from NEWEST to OLDEST, adding messages until we hit the token budget.
 * This ensures we keep the most recent context when the branch is too long.
 *
 * Also collects file operations from:
 * - Tool calls in assistant messages
 * - Existing branch_summary entries' details (for cumulative tracking)
 *
 * @param entries - Entries in chronological order
 * @param tokenBudget - Maximum tokens to include (0 = no limit)
 */
export function prepareBranchEntries(entries, tokenBudget = 0) {
    const messages = [];
    const fileOps = createFileOps();
    let totalTokens = 0;
    // First pass: collect file ops from ALL entries (even if they don't fit in token budget)
    // This ensures we capture cumulative file tracking from nested branch summaries
    // Only extract from pi-generated summaries (fromHook !== true), not extension-generated ones
    for (const entry of entries) {
        if (entry.type === "branch_summary" && !entry.fromHook && entry.details) {
            const details = entry.details;
            if (Array.isArray(details.readFiles)) {
                for (const f of details.readFiles)
                    fileOps.read.add(f);
            }
            if (Array.isArray(details.modifiedFiles)) {
                for (const f of details.modifiedFiles) {
                    fileOps.edited.add(f);
                }
            }
        }
    }
    for (let i = entries.length - 1; i >= 0; i--) {
        const entry = entries[i];
        const message = getMessageFromEntry(entry);
        if (!message)
            continue;
        extractFileOpsFromMessage(message, fileOps);
        const tokens = estimateTokens(message);
        if (tokenBudget > 0 && totalTokens + tokens > tokenBudget) {
            if (entry.type === "compaction" || entry.type === "branch_summary") {
                if (totalTokens < tokenBudget * 0.9) {
                    messages.unshift(message);
                    totalTokens += tokens;
                }
            }
            break;
        }
        messages.unshift(message);
        totalTokens += tokens;
    }
    return { messages, fileOps, totalTokens };
}
const BRANCH_SUMMARY_PREAMBLE = `The user explored a different conversation branch before returning here.
Summary of that exploration:

`;
const BRANCH_SUMMARY_PROMPT = `Create a structured summary of this conversation branch for context when returning later.

Use this EXACT format:

## Goal
[What was the user trying to accomplish in this branch?]

## Constraints & Preferences
- [Any constraints, preferences, or requirements mentioned]
- [Or "(none)" if none were mentioned]

## Progress
### Done
- [x] [Completed tasks/changes]

### In Progress
- [ ] [Work that was started but not finished]

### Blocked
- [Issues preventing progress, if any]

## Key Decisions
- **[Decision]**: [Brief rationale]

## Next Steps
1. [What should happen next to continue this work]

Keep each section concise. Preserve exact file paths, function names, and error messages.`;
/**
 * Generate a summary of abandoned branch entries.
 *
 * @param entries - Session entries to summarize (chronological order)
 * @param options - Generation options
 */
export async function generateBranchSummary(entries, options) {
    const { model, apiKey, headers, signal, customInstructions, replaceInstructions, reserveTokens = 16384 } = options;
    const contextWindow = model.contextWindow || 128000;
    const tokenBudget = contextWindow - reserveTokens;
    const { messages, fileOps } = prepareBranchEntries(entries, tokenBudget);
    // Nothing model-visible remains after filtering.
    if (messages.length === 0) {
        return { summary: "No content to summarize" };
    }
    // Serialize before the LLM call so it summarizes rather than continues this branch.
    const llmMessages = convertToLlm(messages);
    const conversationText = serializeConversation(llmMessages);
    let instructions;
    if (replaceInstructions && customInstructions) {
        instructions = customInstructions;
    }
    else if (customInstructions) {
        instructions = `${BRANCH_SUMMARY_PROMPT}\n\nAdditional focus: ${customInstructions}`;
    }
    else {
        instructions = BRANCH_SUMMARY_PROMPT;
    }
    const promptText = `<conversation>\n${conversationText}\n</conversation>\n\n${instructions}`;
    const summarizationMessages = [
        {
            role: "user",
            content: [{ type: "text", text: promptText }],
            timestamp: Date.now(),
        },
    ];
    const response = await completeSimple(model, { systemPrompt: SUMMARIZATION_SYSTEM_PROMPT, messages: summarizationMessages }, { apiKey, headers, signal, maxTokens: 2048 });
    if (response.stopReason === "aborted") {
        return { aborted: true };
    }
    if (response.stopReason === "error") {
        return { error: response.errorMessage || "Summarization failed" };
    }
    let summary = response.content
        .filter((c) => c.type === "text")
        .map((c) => c.text)
        .join("\n");
    summary = BRANCH_SUMMARY_PREAMBLE + summary;
    const { readFiles, modifiedFiles } = computeFileLists(fileOps);
    summary += formatFileOperations(readFiles, modifiedFiles);
    return {
        summary: summary || "No summary generated",
        readFiles,
        modifiedFiles,
    };
}
//# sourceMappingURL=branch-summarization.js.map