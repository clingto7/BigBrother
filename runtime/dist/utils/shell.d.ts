export interface ShellConfig {
    shell: string;
    args: string[];
}
/**
 * Resolve shell configuration based on platform and an optional explicit shell path.
 * Resolution order:
 * 1. User-specified shellPath
 * 2. On Windows: Git Bash in known locations, then bash on PATH
 * 3. On Unix: /bin/bash, then bash on PATH, then fallback to sh
 */
export declare function getShellConfig(customShellPath?: string): ShellConfig;
/**
 * Absolute default shell for the kernel's bash(): explicit shellPath wins; POSIX
 * uses /bin/bash else /bin/sh (absolute, never PATH — the kernel inherits a
 * user-influenced PATH); win32 uses only the canonical Git Bash install paths,
 * never PATH (a repo-controlled PATH/where.exe must not pick the kernel shell).
 * undefined = no shell found: kernel startup must not fail, bash() raises its
 * teaching error.
 */
export declare function resolveKernelBashShell(customShellPath?: string): string | undefined;
export declare function getShellEnv(): NodeJS.ProcessEnv;
/**
 * Sanitize binary output for display/storage.
 * Removes characters that crash string-width or cause display issues:
 * - Control characters (except tab, newline, carriage return)
 * - Lone surrogates
 * - Unicode Format characters (crash string-width due to a bug)
 * - Characters with undefined code points
 */
export declare function sanitizeBinaryOutput(str: string): string;
export declare function trackDetachedChildPid(pid: number): void;
export declare function untrackDetachedChildPid(pid: number): void;
export declare function killTrackedDetachedChildren(): void;
/**
 * Kill a process and all its children (cross-platform)
 */
export declare function killProcessTree(pid: number): void;
//# sourceMappingURL=shell.d.ts.map