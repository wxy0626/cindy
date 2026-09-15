/** A build target managed by the deferred build coordinator. */
export interface BuildTarget {
  /** Stable target identifier (for example, a worker entry name). */
  readonly id: string;
  /** Critical targets block startup; deferred targets run after startup. */
  readonly critical?: boolean;
  /** Performs one build. Rejected builds remain retryable. */
  readonly build: () => Promise<void>;
}

/** Observable state for a target. */
export type BuildState = 'pending' | 'building' | 'ready' | 'failed';

/** Split targets into startup-critical and post-start deferred groups. */
export function createDeferredBuildPlan(targets: readonly BuildTarget[], eager = false): {
  readonly critical: readonly BuildTarget[];
  readonly deferred: readonly BuildTarget[];
  readonly eager: boolean;
} {
  const critical: BuildTarget[] = [];
  const deferred: BuildTarget[] = [];
  for (const target of targets) {
    (target.critical ? critical : deferred).push(target);
  }
  return { critical, deferred, eager };
}

interface TargetRecord {
  readonly target: BuildTarget;
  buildId: number;
  state: BuildState;
  inFlight?: Promise<void>;
  error?: unknown;
}

/**
 * Coordinates critical and deferred Vite target builds.
 *
 * This module deliberately knows nothing about Forge or Vite. The fork can
 * adapt its existing `vite.build` calls to `BuildTarget.build`, while callers
 * can await `ensure()` before first using a deferred worker.
 */
export class DeferredBuildCoordinator {
  private readonly records = new Map<string, TargetRecord>();
  private readonly eager: boolean;

  constructor(targets: readonly BuildTarget[], options: { eager?: boolean } = {}) {
    this.eager = options.eager ?? process.env.XDT_EAGER_WORKERS === '1';
    for (const target of targets) {
      if (this.records.has(target.id)) {
        throw new Error(`Duplicate build target: ${target.id}`);
      }
      this.records.set(target.id, { target, buildId: 0, state: 'pending' });
    }
  }

  /** Whether this coordinator uses the legacy eager behavior. */
  get isEager(): boolean {
    return this.eager;
  }

  /** Build all critical targets, then enqueue deferred targets in the background. */
  async start(): Promise<void> {
    const critical = [...this.records.values()].filter((record) => record.target.critical);
    await Promise.all(critical.map((record) => this.run(record)));
    if (this.eager) {
      await Promise.all([...this.records.values()].map((record) => this.run(record)));
    } else {
      const deferred = [...this.records.values()].filter((record) => !record.target.critical);
      for (const record of deferred) {
        void this.run(record).catch(() => undefined);
      }
    }
  }

  /** Wait until a target has a current successful build; concurrent calls share one build. */
  ensure(id: string): Promise<void> {
    const record = this.records.get(id);
    if (!record) return Promise.reject(new Error(`Unknown build target: ${id}`));
    return this.run(record);
  }

  /** Return the latest state, useful for diagnostics and readiness endpoints. */
  getState(id: string): BuildState {
    const record = this.records.get(id);
    if (!record) throw new Error(`Unknown build target: ${id}`);
    return record.state;
  }

  /** Invalidate a target so its next ensure performs a fresh build. */
  invalidate(id: string): void {
    const record = this.records.get(id);
    if (!record) throw new Error(`Unknown build target: ${id}`);
    record.buildId += 1;
    record.state = 'pending';
    record.error = undefined;
    // Detach an in-flight older generation so ensure() starts the new one.
    record.inFlight = undefined;
  }

  private run(record: TargetRecord): Promise<void> {
    if (record.state === 'ready') return Promise.resolve();
    if (record.inFlight) return record.inFlight;
    const buildId = record.buildId;
    record.state = 'building';
    const promise = record.target.build().then(
      () => {
        // An invalidation during the build makes this result stale.
        if (record.buildId === buildId) {
          record.state = 'ready';
          record.error = undefined;
        }
      },
      (error: unknown) => {
        if (record.buildId === buildId) {
          record.state = 'failed';
          record.error = error;
        }
        throw error;
      },
    ).finally(() => {
      if (record.inFlight === promise) record.inFlight = undefined;
    });
    record.inFlight = promise;
    return promise;
  }
}
