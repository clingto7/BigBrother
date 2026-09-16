import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Model, ServiceTier } from "@earendil-works/pi-ai";
import type { AgentSessionMessageController } from "./agent-messages.js";
import type { AgentObserveController } from "./agent-observe.js";
import type { AgentExecutionMode } from "./agent-session-config.js";
import { AuthStorage } from "./auth-storage.js";
import type { AgentAutonomousConfig } from "./autonomous.js";
import type { AgentRlmHeartbeatController } from "./cron-jobs.js";
import type { SessionStartEvent, ToolDefinition } from "./extensions/index.js";
import { McpManager } from "./mcp/mcp-manager.js";
import { ModelRegistry } from "./model-registry.js";
import { type DefaultResourceLoaderOptions, type ResourceLoader } from "./resource-loader.js";
import type { SubagentRuntimeHost } from "./rlm-runtime.js";
import { type CreateAgentSessionResult } from "./sdk.js";
import type { SessionManager } from "./session-manager.js";
import { SettingsManager } from "./settings-manager.js";
export interface AgentSessionRuntimeDiagnostic {
    type: "info" | "warning" | "error";
    message: string;
}
export interface CreateAgentSessionServicesOptions {
    cwd: string;
    agentDir?: string;
    authStorage?: AuthStorage;
    settingsManager?: SettingsManager;
    modelRegistry?: ModelRegistry;
    extensionFlagValues?: Map<string, boolean | string>;
    resourceLoaderOptions?: Omit<DefaultResourceLoaderOptions, "cwd" | "agentDir" | "settingsManager">;
    /**
     * Skip the built-in Herdr reporter for these services. Set for RLM subagent
     * runtimes: they inherit the parent's HERDR_* pane identity, so their own
     * reporter would race the parent's on the same pane and a subagent quit
     * would release the pane while the parent is still running.
     */
    noBuiltinHerdrReporter?: boolean;
    telemetryDisabled?: true;
}
export interface AgentSessionCreationOptions {
    model?: Model<any>;
    thinkingLevel?: ThinkingLevel;
    serviceTier?: ServiceTier;
    scopedModels?: Array<{
        model: Model<any>;
        thinkingLevel?: ThinkingLevel;
    }>;
    tools?: string[];
    noTools?: "all" | "builtin";
    customTools?: ToolDefinition[];
    initialActiveToolNames?: string[];
    allowedToolNames?: string[];
    includeGoals?: boolean;
    includeCompactSkill?: boolean;
    agentMessageController?: AgentSessionMessageController;
    agentObserveController?: AgentObserveController;
    rlmDepth?: number;
    rlmMaxDepth?: number;
    rlmSessionDir?: string;
    rlmParentNodeId?: string;
    rlmParentAgent?: string;
    subagentRuntimeHost?: SubagentRuntimeHost;
    rlmHeartbeatController?: AgentRlmHeartbeatController;
    prewarmIpythonKernel?: boolean;
    autonomous?: AgentAutonomousConfig;
    serializedRefine?: boolean;
    executionMode?: AgentExecutionMode;
    telemetryDisabled?: true;
    initialGoal?: {
        objective: string;
        tokenBudget?: number;
    };
}
export interface CreateAgentSessionFromServicesOptions extends AgentSessionCreationOptions {
    services: AgentSessionServices;
    sessionManager: SessionManager;
    sessionStartEvent?: SessionStartEvent;
}
export interface AgentSessionServices {
    cwd: string;
    agentDir: string;
    authStorage: AuthStorage;
    settingsManager: SettingsManager;
    modelRegistry: ModelRegistry;
    resourceLoader: ResourceLoader;
    mcpManager: McpManager;
    diagnostics: AgentSessionRuntimeDiagnostic[];
}
export declare function createAgentSessionServices(options: CreateAgentSessionServicesOptions): Promise<AgentSessionServices>;
export declare function createAgentSessionFromServices(options: CreateAgentSessionFromServicesOptions): Promise<CreateAgentSessionResult>;
//# sourceMappingURL=agent-session-services.d.ts.map