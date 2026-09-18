import { join } from "node:path";
import { Agent } from "@earendil-works/pi-agent-core";
import { clampThinkingLevel, streamSimple, supportsFastMode } from "@earendil-works/pi-ai";
import { getAgentDir } from "../config.js";
import { AgentSession } from "./agent-session.js";
import { formatNoModelsAvailableMessage } from "./auth-guidance.js";
import { AuthStorage } from "./auth-storage.js";
import { DEFAULT_THINKING_LEVEL } from "./defaults.js";
import { McpManager } from "./mcp/mcp-manager.js";
import { convertToLlm } from "./messages.js";
import { ModelRegistry } from "./model-registry.js";
import { findInitialModel } from "./model-resolver.js";
import { DefaultResourceLoader } from "./resource-loader.js";
import { getDefaultSessionDir, SessionManager } from "./session-manager.js";
import { SettingsManager } from "./settings-manager.js";
import { time } from "./timings.js";
import { createBashTool, createEditTool, createIpythonTool, withFileMutationQueue } from "./tools/index.js";
export * from "./agent-session-runtime.js";
export { createBashTool, createEditTool, createIpythonTool, withFileMutationQueue };
function getDefaultAgentDir() {
    return getAgentDir();
}
/**
 * Create an AgentSession with the specified options.
 *
 * @example
 * ```typescript
 * // Minimal - uses defaults
 * const { session } = await createAgentSession();
 *
 * // With explicit model
 * import { getModel } from '@earendil-works/pi-ai';
 * const { session } = await createAgentSession({
 *   model: getModel('anthropic', 'claude-opus-4-5'),
 *   thinkingLevel: 'high',
 * });
 *
 * // Continue previous session
 * const { session, modelFallbackMessage } = await createAgentSession({
 *   continueSession: true,
 * });
 *
 * // Full control
 * const loader = new DefaultResourceLoader({
 *   cwd: process.cwd(),
 *   agentDir: getAgentDir(),
 *   settingsManager: SettingsManager.create(),
 * });
 * await loader.reload();
 * const { session } = await createAgentSession({
 *   model: myModel,
 *   tools: ["ipython"],
 *   resourceLoader: loader,
 *   sessionManager: SessionManager.inMemory(),
 * });
 * ```
 */
export async function createAgentSession(options = {}) {
    const cwd = options.cwd ?? options.sessionManager?.getCwd() ?? process.cwd();
    const agentDir = options.agentDir ?? getDefaultAgentDir();
    let resourceLoader = options.resourceLoader;
    const authPath = options.agentDir ? join(agentDir, "auth.json") : undefined;
    const modelsPath = options.agentDir ? join(agentDir, "models.json") : undefined;
    const authStorage = options.authStorage ?? AuthStorage.create(authPath);
    const modelRegistry = options.modelRegistry ?? ModelRegistry.create(authStorage, modelsPath);
    const settingsManager = options.settingsManager ?? SettingsManager.create(cwd, agentDir);
    const sessionManager = options.sessionManager ?? SessionManager.create(cwd, getDefaultSessionDir(cwd, agentDir));
    // Ensure MCP providers are registered and built-in MCP skills are gated by
    // auth even on the bare SDK path (not just the CLI's createAgentSessionServices).
    const mcpManager = options.mcpManager ??
        new McpManager({ authStorage, getUserServers: () => settingsManager.getGlobalMcpServers() });
    modelRegistry.setOnOAuthProvidersReset(() => mcpManager.registerUserProviders());
    if (!resourceLoader) {
        resourceLoader = new DefaultResourceLoader({
            cwd,
            agentDir,
            settingsManager,
            extraBuiltinSkillOverrides: () => mcpManager.getDisabledBuiltinSkillOverrides(),
        });
        await resourceLoader.reload();
        time("resourceLoader.reload");
    }
    const existingSession = sessionManager.buildSessionContext();
    const hasExistingSession = existingSession.messages.length > 0;
    const hasThinkingEntry = sessionManager.getBranch().some((entry) => entry.type === "thinking_level_change");
    const hasServiceTierEntry = sessionManager.getBranch().some((entry) => entry.type === "service_tier_change");
    let model = options.model;
    let modelFallbackMessage;
    if (!model && hasExistingSession && existingSession.model) {
        const restoredModel = modelRegistry.find(existingSession.model.provider, existingSession.model.modelId);
        if (restoredModel && modelRegistry.hasConfiguredAuth(restoredModel)) {
            model = restoredModel;
        }
        if (!model) {
            modelFallbackMessage = `Could not restore model ${existingSession.model.provider}/${existingSession.model.modelId}`;
        }
    }
    if (!model) {
        const result = await findInitialModel({
            scopedModels: [],
            isContinuing: hasExistingSession,
            defaultProvider: settingsManager.getDefaultProvider(),
            defaultModelId: settingsManager.getDefaultModel(),
            defaultThinkingLevel: settingsManager.getDefaultThinkingLevel(),
            modelRegistry,
        });
        model = result.model;
        if (!model) {
            modelFallbackMessage = formatNoModelsAvailableMessage();
        }
        else if (modelFallbackMessage) {
            modelFallbackMessage += `. Using ${model.provider}/${model.id}`;
        }
    }
    let thinkingLevel = options.thinkingLevel;
    if (thinkingLevel === undefined && hasExistingSession) {
        thinkingLevel = hasThinkingEntry
            ? existingSession.thinkingLevel
            : (settingsManager.getDefaultThinkingLevel() ?? DEFAULT_THINKING_LEVEL);
    }
    if (thinkingLevel === undefined) {
        thinkingLevel = settingsManager.getDefaultThinkingLevel() ?? DEFAULT_THINKING_LEVEL;
    }
    if (!model) {
        thinkingLevel = "off";
    }
    else {
        thinkingLevel = clampThinkingLevel(model, thinkingLevel);
    }
    const serviceTierPreference = options.serviceTier ??
        (hasServiceTierEntry ? existingSession.serviceTier : settingsManager.getDefaultServiceTier());
    const serviceTier = serviceTierPreference === "priority" && (!model || !supportsFastMode(model)) ? "default" : serviceTierPreference;
    const allowedToolNames = options.allowedToolNames ?? options.tools ?? (options.noTools === "all" ? [] : undefined);
    const includeGoals = options.includeGoals ?? (options.tools !== undefined || options.noTools !== "all");
    const initialActiveToolNames = options.initialActiveToolNames ?? (options.tools ? [...options.tools] : options.noTools ? [] : ["ipython"]);
    let agent;
    const convertToLlmWithBlockImages = (messages) => {
        const converted = convertToLlm(messages);
        if (!settingsManager.getBlockImages()) {
            return converted;
        }
        return converted.map((msg) => {
            if (msg.role === "user" || msg.role === "toolResult") {
                const content = msg.content;
                if (Array.isArray(content)) {
                    const hasImages = content.some((c) => c.type === "image");
                    if (hasImages) {
                        const filteredContent = content
                            .map((c) => c.type === "image" ? { type: "text", text: "Image reading is disabled." } : c)
                            .filter((c, i, arr) => !(c.type === "text" &&
                            c.text === "Image reading is disabled." &&
                            i > 0 &&
                            arr[i - 1].type === "text" &&
                            arr[i - 1].text === "Image reading is disabled."));
                        return { ...msg, content: filteredContent };
                    }
                }
            }
            return msg;
        });
    };
    const extensionRunnerRef = {};
    agent = new Agent({
        initialState: {
            systemPrompt: "",
            model,
            thinkingLevel,
            serviceTier,
            tools: [],
        },
        convertToLlm: convertToLlmWithBlockImages,
        streamFn: async (model, context, options) => {
            const auth = await modelRegistry.getApiKeyAndHeaders(model);
            if (!auth.ok) {
                throw new Error(auth.error);
            }
            const providerRetrySettings = settingsManager.getProviderRetrySettings();
            return streamSimple(model, context, {
                ...options,
                apiKey: auth.apiKey,
                timeoutMs: options?.timeoutMs ?? providerRetrySettings.timeoutMs,
                maxRetries: options?.maxRetries ?? providerRetrySettings.maxRetries,
                maxRetryDelayMs: options?.maxRetryDelayMs ?? providerRetrySettings.maxRetryDelayMs,
                headers: auth.headers || options?.headers ? { ...auth.headers, ...options?.headers } : undefined,
            });
        },
        onPayload: async (payload, _model) => {
            const runner = extensionRunnerRef.current;
            if (!runner?.hasHandlers("before_provider_request")) {
                return payload;
            }
            return runner.emitBeforeProviderRequest(payload);
        },
        onResponse: async (response, _model) => {
            const runner = extensionRunnerRef.current;
            if (!runner?.hasHandlers("after_provider_response")) {
                return;
            }
            await runner.emit({
                type: "after_provider_response",
                status: response.status,
                headers: response.headers,
            });
        },
        sessionId: sessionManager.getSessionId(),
        transformContext: async (messages) => {
            const runner = extensionRunnerRef.current;
            if (!runner)
                return messages;
            return runner.emitContext(messages);
        },
        steeringMode: settingsManager.getSteeringMode(),
        followUpMode: settingsManager.getFollowUpMode(),
        transport: settingsManager.getTransport(),
        thinkingBudgets: settingsManager.getThinkingBudgets(),
        maxRetryDelayMs: settingsManager.getProviderRetrySettings().maxRetryDelayMs,
    });
    if (hasExistingSession) {
        agent.state.messages = existingSession.messages;
        if (!hasThinkingEntry) {
            sessionManager.appendThinkingLevelChange(thinkingLevel);
        }
    }
    else {
        if (model) {
            sessionManager.appendModelChange(model.provider, model.id);
        }
        sessionManager.appendThinkingLevelChange(thinkingLevel);
    }
    if (!hasServiceTierEntry) {
        sessionManager.appendServiceTierChange(serviceTierPreference);
    }
    const session = new AgentSession({
        agent,
        sessionManager,
        settingsManager,
        serviceTierPreference,
        cwd,
        // Only the explicit dir — the default may not match injected custom storage.
        agentDir: options.agentDir,
        scopedModels: options.scopedModels,
        resourceLoader,
        customTools: options.customTools,
        modelRegistry,
        mcpManager,
        initialActiveToolNames,
        allowedToolNames,
        includeGoals,
        includeCompactSkill: options.includeCompactSkill,
        rlmHeartbeatController: options.rlmHeartbeatController,
        agentMessageController: options.agentMessageController,
        agentObserveController: options.agentObserveController,
        extensionRunnerRef,
        rlmDepth: options.rlmDepth,
        rlmMaxDepth: options.rlmMaxDepth,
        rlmSessionDir: options.rlmSessionDir,
        rlmParentNodeId: options.rlmParentNodeId,
        rlmParentAgent: options.rlmParentAgent,
        subagentRuntimeHost: options.subagentRuntimeHost,
        sessionStartEvent: options.sessionStartEvent,
        prewarmIpythonKernel: options.prewarmIpythonKernel,
        autonomous: options.autonomous,
        serializedRefine: options.serializedRefine,
        initialGoal: options.initialGoal,
    });
    const extensionsResult = resourceLoader.getExtensions();
    return {
        session,
        extensionsResult,
        modelFallbackMessage,
    };
}
//# sourceMappingURL=sdk.js.map