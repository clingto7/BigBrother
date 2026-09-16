// Host side of MCP integrations. The protocol itself runs Python-side in the kernel; the host
// only registers OAuth providers, gates integration skills by auth, and serves mcp.* host-requests.
import { BUILTIN_MCP_CATALOG, createMcpOAuthProvider, getCatalogEntry, registerBuiltinMcpOAuthProviders, } from "@earendil-works/pi-ai/mcp";
import { registerOAuthProvider, unregisterOAuthProvider } from "@earendil-works/pi-ai/oauth";
/** A resolved integration: a catalog/user entry plus its provider id. */
const GENERIC_SERVER_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
export class McpManager {
    authStorage;
    getUserServers;
    beginLogin;
    integrations = new Map();
    acpServers = new Map();
    acpOwnerId;
    /** Provider ids we registered for user servers, so refresh can drop removed ones. */
    registeredUserProviderIds = new Set();
    constructor(options) {
        this.authStorage = options.authStorage;
        this.getUserServers = options.getUserServers ?? (() => undefined);
        this.beginLogin = options.beginLogin;
        this.resolveIntegrations();
        this.registerProviders();
    }
    /** Re-read settings and re-register providers; call after a session reload. */
    refresh() {
        this.resolveIntegrations();
        this.registerProviders();
    }
    canReleaseAcpServers(ownerId) {
        return this.acpOwnerId === undefined || this.acpOwnerId === ownerId;
    }
    replaceAcpServers(servers, ownerId) {
        if (!ownerId)
            throw new Error("ACP MCP owner id is required");
        if (servers.length === 0 && this.acpOwnerId !== ownerId)
            return false;
        if (servers.length > 0 && this.acpOwnerId && this.acpOwnerId !== ownerId) {
            throw new Error("ACP MCP configuration is owned by another client");
        }
        const next = new Map();
        for (const server of servers) {
            if (next.has(server.name))
                throw new Error(`Duplicate ACP MCP server: ${server.name}`);
            next.set(server.name, server);
        }
        const unchanged = next.size === this.acpServers.size &&
            Array.from(next).every(([name, config]) => JSON.stringify(this.acpServers.get(name)) === JSON.stringify(config));
        if (unchanged)
            return false;
        this.acpServers = next;
        this.acpOwnerId = next.size > 0 ? ownerId : undefined;
        return true;
    }
    providerId(server) {
        return `mcp:${server}`;
    }
    resolveIntegrations() {
        const integrations = new Map();
        for (const entry of BUILTIN_MCP_CATALOG) {
            integrations.set(entry.server, {
                server: entry.server,
                label: entry.label,
                config: { type: "http", url: entry.url, oauth: true },
                usesOAuth: entry.oauth?.kind === "oauth",
            });
        }
        for (const [server, config] of Object.entries(this.getUserServers() ?? {})) {
            integrations.set(server, {
                server,
                label: server,
                config,
                usesOAuth: config.type === "http" && config.oauth === true,
                userDeclared: true,
            });
        }
        this.integrations = integrations;
    }
    registerProviders() {
        registerBuiltinMcpOAuthProviders();
        this.registerUserProviders();
    }
    /**
     * Register OAuth providers for user-declared (non-catalog) servers. Public so it
     * can run after ModelRegistry.refresh() resets the registry — otherwise custom
     * `mcp:<server>` providers vanish on every refresh (e.g. post-login).
     */
    registerUserProviders() {
        const current = new Set();
        for (const integration of this.integrations.values()) {
            if (!integration.userDeclared || integration.config.type !== "http" || getCatalogEntry(integration.server)) {
                continue;
            }
            const id = this.providerId(integration.server);
            if (integration.usesOAuth) {
                current.add(id);
                registerOAuthProvider(createMcpOAuthProvider({
                    server: integration.server,
                    label: integration.label,
                    url: integration.config.url,
                }));
            }
        }
        // Drop providers for user servers removed since the last registration.
        for (const id of this.registeredUserProviderIds) {
            if (!current.has(id))
                unregisterOAuthProvider(id);
        }
        this.registeredUserProviderIds = current;
    }
    /** True when valid credentials exist for the integration (drives enablement). */
    isAuthed(integration) {
        if (integration.config.enabled === false)
            return false;
        if (integration.userDeclared && getCatalogEntry(integration.server))
            return false;
        if (integration.config.type === "stdio")
            return true;
        const { bearerTokenEnvVar } = integration.config;
        if (!integration.usesOAuth && !bearerTokenEnvVar)
            return true;
        if (bearerTokenEnvVar && process.env[bearerTokenEnvVar]?.trim()) {
            return true;
        }
        const cred = this.authStorage.get(this.providerId(integration.server));
        if (cred === undefined)
            return false;
        // Builtin URLs are code-constant; only user-declared endpoints can be retargeted, so only their
        // tokens must prove where they belong. Mismatched or unbound tokens require re-login.
        if (!integration.userDeclared)
            return true;
        const endpoint = cred.endpoint;
        return typeof endpoint === "string" && endpoint === integration.config.url;
    }
    /** `-<server>/SKILL.md` overrides for every built-in integration the user isn't logged into. */
    getDisabledBuiltinSkillOverrides() {
        const overrides = [];
        for (const entry of BUILTIN_MCP_CATALOG) {
            const integration = this.integrations.get(entry.server);
            if (integration && !this.isAuthed(integration)) {
                overrides.push(`-${entry.server}/SKILL.md`);
            }
        }
        return overrides;
    }
    /** Host-request handlers exposed to the kernel. */
    hostHandlers() {
        const handlers = {
            "mcp.refresh": async (payload) => {
                const server = String(payload.server ?? "");
                if (!server)
                    throw new Error("mcp.refresh requires a server");
                if (this.acpServers.has(server))
                    throw new Error(`ACP MCP server ${server} does not use host OAuth`);
                // getApiKey refreshes + rewrites auth.json under lock; Python re-reads.
                // Surface failure (throw) instead of a false success so the kernel can
                // report a refresh error rather than a misleading "not enabled".
                const key = await this.authStorage.getApiKey(this.providerId(server));
                if (!key)
                    throw new Error(`Could not refresh credentials for ${server}`);
                return {};
            },
            // Resolved config so the kernel skill connects to the same URL the host
            // registered/authenticated (honors a user's mcpServers `url` override).
            "mcp.config": async (payload) => {
                const server = String(payload.server ?? "");
                if (!server)
                    throw new Error("mcp.config requires a server");
                const acpServer = this.acpServers.get(server);
                if (acpServer) {
                    const { name: _name, ...config } = acpServer;
                    return { ...config, credentialSource: "acp" };
                }
                const integration = this.integrations.get(server);
                if (!integration?.userDeclared || getCatalogEntry(server))
                    return {};
                return { ...integration.config };
            },
        };
        // Only expose begin_login when an interactive login is actually wired, so the
        // kernel doesn't get a handler whose only behavior is to throw.
        const beginLogin = this.beginLogin;
        if (beginLogin) {
            handlers["mcp.begin_login"] = async (payload) => {
                const server = String(payload.server ?? "");
                if (!server)
                    throw new Error("mcp.begin_login requires a server");
                await beginLogin(server);
                return {};
            };
        }
        return handlers;
    }
    /** Enabled persistent and session-scoped servers available through the generic kernel API. */
    getEnabledGenericServers() {
        const servers = Array.from(this.integrations.values())
            .filter((integration) => integration.userDeclared &&
            GENERIC_SERVER_NAME_PATTERN.test(integration.server) &&
            !getCatalogEntry(integration.server) &&
            this.isAuthed(integration))
            .map((integration) => integration.server);
        for (const server of this.acpServers.keys())
            servers.push(server);
        return [...new Set(servers)].sort((left, right) => left.localeCompare(right));
    }
    /** Status for the /mcp list command. */
    listStatus() {
        return Array.from(this.integrations.values()).map((integration) => ({
            server: integration.server,
            label: integration.label,
            enabled: this.isAuthed(integration),
            usesOAuth: integration.usesOAuth,
        }));
    }
}
//# sourceMappingURL=mcp-manager.js.map