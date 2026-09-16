/** Default ceiling on a snapshot payload. Over-cap variables are skipped + reported. */
export declare const DEFAULT_SNAPSHOT_MAX_BYTES: number;
/** Default ceiling for one serialized variable. */
export declare const DEFAULT_SNAPSHOT_MAX_VARIABLE_BYTES: number;
export interface SnapshotResult {
    /** Top-level names successfully serialized into the payload. */
    saved: string[];
    /** Names that could not be serialized, with a short reason. */
    skipped: {
        name: string;
        reason: string;
    }[];
    /** Oversized live variables removed by an explicit compaction snapshot. */
    pruned?: string[];
    /** Payload size on disk, in bytes. */
    bytes: number;
    path: string;
}
export interface RestoreResult {
    /** Names successfully revived into the kernel namespace. */
    restored: string[];
    /** Names present in the snapshot that failed to revive, with a short reason. */
    failed: {
        name: string;
        reason: string;
    }[];
    path: string;
}
/** Absolute path to the dill payload within a session's artifact directory. */
export declare function snapshotPathIn(artifactDir: string): string;
/** Absolute path to the JSON manifest within a session's artifact directory. */
export declare function manifestPathIn(artifactDir: string): string;
//# sourceMappingURL=state-snapshot.d.ts.map