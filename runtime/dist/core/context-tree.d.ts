import type { Usage } from "@earendil-works/pi-ai";
import type { RlmChildAgentStatus } from "./agent-session.js";
import type { ContextUsage } from "./extensions/index.js";
import { type SessionEntry } from "./session-manager.js";
/** Resolves a model's context window so disk-only nodes can report utilization. */
export type ContextWindowResolver = (provider: string, modelId: string) => number | undefined;
/**
 * One agent in the context overview: the main session or an RLM (sub-)agent.
 * `ownUsage` excludes descendants; `totalUsage` includes completed descendants, matching /usage.
 */
export interface ContextTreeNode {
    /** "root" for the session itself; sub-xxxx for an RLM child. */
    id: string;
    label: string;
    status: "active" | RlmChildAgentStatus;
    model?: {
        provider: string;
        id: string;
    };
    ownUsage: Usage;
    totalUsage: Usage;
    contextUsage?: ContextUsage;
    children: ContextTreeNode[];
}
/**
 * Usage totals for one agent: `totalUsage` sums the branch's assistant usage
 * (attributed aggregates, so descendants are included), `ownUsage` removes the
 * attributions targeting those assistants. Attribution entries are matched by
 * target across ALL entries, not just the branch: attributions rewrite the
 * target assistant's usage no matter which branch they were appended on, so a
 * fork that keeps the assistant but drops the attribution entry must still
 * subtract it.
 *
 * Totals are deliberately cumulative across compactions: compaction shrinks
 * the model-facing context, not what the session has spent, so assistants
 * dropped from the resolved context still count here.
 */
export declare function computeOwnAndTotalUsage(branch: SessionEntry[], allEntries: SessionEntry[]): {
    ownUsage: Usage;
    totalUsage: Usage;
};
/**
 * Build a context node for a completed RLM child from its persisted session
 * dir (sub-xxxx/). Children that already attributed grandchild usage carry the
 * aggregate on their assistant messages (applyChildUsageAttributions), so own
 * usage is recovered by subtracting the attribution entries. Returns undefined
 * when the dir holds no readable session.
 */
export declare function loadContextTreeChildFromDisk(childSessionDir: string, resolveContextWindow: ContextWindowResolver): ContextTreeNode | undefined;
/**
 * Build context nodes for all persisted RLM children under an RLM session
 * dir, recursing into nested sub-* dirs for grandchildren. `skipIds`
 * excludes children that are already represented live.
 */
export declare function loadContextTreeChildrenFromDisk(rlmSessionDir: string | undefined, resolveContextWindow: ContextWindowResolver, skipIds?: ReadonlySet<string>): ContextTreeNode[];
//# sourceMappingURL=context-tree.d.ts.map