import type { McpServerConfig, SettingsManager } from "../settings-manager.js";
export type McpManagementAction = "add" | "list" | "get" | "remove";
export interface McpManagementResult {
    action: McpManagementAction;
    message: string;
    changed: boolean;
    serverChange?: {
        name: string;
        transport: McpServerConfig["type"];
        verb: "added" | "replaced" | "removed";
        usesOAuth: boolean;
    };
}
export interface McpCredentialStore {
    /** Disk-verified removal: throws when the credential may still exist on disk. */
    removeVerified(provider: string): void;
}
export declare function runMcpManagementCommand(args: readonly string[], settingsManager: SettingsManager, authStorage?: McpCredentialStore): Promise<McpManagementResult>;
export declare function parseMcpAddArgs(args: readonly string[]): {
    name: string;
    config: McpServerConfig;
    force: boolean;
};
export declare function formatMcpServerList(servers: Record<string, McpServerConfig> | undefined): string;
export declare function formatMcpServer(name: string, config: McpServerConfig): string;
//# sourceMappingURL=mcp-command.d.ts.map