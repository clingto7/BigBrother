export const WORKER_ATTEMPT_STATUSES = Object.freeze([
	"success",
	"timed_out",
	"crashed",
	"cancelled",
	"protocol_failed",
	"cleanup_failed",
]);

export function isWorkerAttemptStatus(status) {
	return WORKER_ATTEMPT_STATUSES.includes(status);
}
