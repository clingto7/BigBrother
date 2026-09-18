import { resolve } from "node:path";
/** Return the lexical socket identity without requiring the socket to exist. */
export function normalizeSocketPath(socketPath, baseDir) {
    if (process.platform === "win32") {
        return socketPath.toLowerCase();
    }
    return baseDir ? resolve(baseDir, socketPath) : resolve(socketPath);
}
//# sourceMappingURL=daemon-socket-path.js.map