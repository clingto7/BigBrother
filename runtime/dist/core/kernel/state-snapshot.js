// Locations and result shapes for the kernel's persisted user namespace, which
// is revived when a session resumes. The kernel is otherwise spawned fresh on
// resume, leaving the model believing it still has access to variables/imports
// it defined earlier.
//
// Snapshotting is best-effort and per-variable: each top-level name is pickled
// with `dill` independently, so a single unpicklable object (open file, socket,
// GPU tensor, …) is skipped and reported rather than aborting the whole snapshot.
import { join } from "node:path";
/** Default ceiling on a snapshot payload. Over-cap variables are skipped + reported. */
export const DEFAULT_SNAPSHOT_MAX_BYTES = 256 * 1024 * 1024;
/** Default ceiling for one serialized variable. */
export const DEFAULT_SNAPSHOT_MAX_VARIABLE_BYTES = 16 * 1024 * 1024;
/** Base filename for the kernel snapshot within a session's artifact directory. */
const KERNEL_STATE_BASENAME = "kernel-state";
/** Absolute path to the dill payload within a session's artifact directory. */
export function snapshotPathIn(artifactDir) {
    return join(artifactDir, `${KERNEL_STATE_BASENAME}.dill`);
}
/** Absolute path to the JSON manifest within a session's artifact directory. */
export function manifestPathIn(artifactDir) {
    return join(artifactDir, `${KERNEL_STATE_BASENAME}.json`);
}
//# sourceMappingURL=state-snapshot.js.map