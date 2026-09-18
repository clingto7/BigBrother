const HANDLE = Symbol("big-brother-prime-runtime-handle");

export class PrimeRuntimeSupervisor {
  #runtimeFactory;
  #entries = new Map();

  constructor({ runtimeFactory }) {
    this.#runtimeFactory = runtimeFactory;
  }

  async start(repositoryProfile, stateNamespace) {
    const repositoryId = repositoryProfile.repositoryId;
    const existing = this.#entries.get(repositoryId);
    if (existing) {
      await existing.startPromise;
      return existing.handle;
    }

    const handle = Object.freeze({ repositoryId, [HANDLE]: true });
    const entry = {
      handle,
      runtime: undefined,
      queue: Promise.resolve(),
      startPromise: undefined,
    };
    entry.startPromise = this.#runtimeFactory
      .start(repositoryProfile, stateNamespace)
      .then((runtime) => {
        if (!runtime) throw new Error(`Prime runtime factory returned no runtime: ${repositoryId}`);
        entry.runtime = runtime;
      })
      .catch((error) => {
        if (this.#entries.get(repositoryId) === entry) this.#entries.delete(repositoryId);
        throw error;
      });
    this.#entries.set(repositoryId, entry);
    await entry.startPromise;
    return handle;
  }

  submitWorkerReview(handle, reviewInput) {
    return this.#submit(handle, "submitWorkerReview", reviewInput);
  }

  reconcileReview(handle, reconciliationInput) {
    return this.#submit(handle, "reconcileReview", reconciliationInput);
  }

	#submit(handle, method, input) {
    const entry = this.#entryFor(handle);
    return entry.startPromise.then(() => {
      // ponytail: serialize per repository until context-conflict handling exists.
      const run = entry.queue.then(() => {
        if (typeof entry.runtime[method] !== "function") {
          throw new Error(`Prime runtime does not support ${method}`);
        }
        return entry.runtime[method](input);
      });
      entry.queue = run.catch(() => undefined);
      return run;
    });
  }

  async recover(handle) {
    const entry = this.#entryFor(handle);
    await entry.startPromise;
    return entry.runtime.recover();
  }

  async startFreshSession(handle) {
    const entry = this.#entryFor(handle);
    await entry.startPromise;
    await entry.queue;
    if (typeof entry.runtime.startFreshSession !== "function") {
      throw new Error("Prime runtime does not support starting a fresh session");
    }
    return entry.runtime.startFreshSession();
  }

  async stop(handle) {
    const entry = this.#entryFor(handle);
    await entry.startPromise;
    await entry.queue;
    try {
      await entry.runtime.stop();
    } finally {
      this.#entries.delete(handle.repositoryId);
    }
  }

  async stopAll() {
    for (const entry of [...this.#entries.values()]) await this.stop(entry.handle);
  }

  #entryFor(handle) {
    const entry = handle?.[HANDLE] ? this.#entries.get(handle.repositoryId) : undefined;
    if (!entry || entry.handle !== handle) {
      throw new Error(`unknown Prime runtime handle: ${handle?.repositoryId ?? "unknown"}`);
    }
    return entry;
  }
}
