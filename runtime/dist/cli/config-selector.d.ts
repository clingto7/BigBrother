import type { ResolvedPaths } from "../core/package-manager.js";
import type { SettingsManager } from "../core/settings-manager.js";
export interface ConfigSelectorOptions {
    resolvedPaths: ResolvedPaths;
    settingsManager: SettingsManager;
    cwd: string;
    agentDir: string;
}
export declare function selectConfig(options: ConfigSelectorOptions): Promise<void>;
//# sourceMappingURL=config-selector.d.ts.map