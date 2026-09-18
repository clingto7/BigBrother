export interface RlmSubagentDisplayEntry {
    type: "rlm_subagent";
    childId: string;
    sessionName: string;
    sessionDir: string;
    sessionFile: string;
    rlmMaxDepth?: number;
    rlmParentNodeId?: string;
    prompt?: string;
    spawnCode?: string;
    model?: {
        provider: string;
        modelId: string;
    };
    status: "running" | "completed" | "deleted";
    createdAt: number;
    updatedAt: string;
}
export declare function rlmSubagentDisplayPath(sessionDir: string): string;
export declare function writeRlmSubagentDisplayEntry(entry: RlmSubagentDisplayEntry): void;
export declare function readRlmSubagentDisplayEntry(sessionDir: string): Promise<RlmSubagentDisplayEntry | undefined>;
//# sourceMappingURL=rlm-subagent-display.d.ts.map