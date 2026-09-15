import { describe, expect, it, vi } from 'vitest';

import { DeferredBuildCoordinator } from '../src/deferred-build-coordinator.js';

describe('DeferredBuildCoordinator', () => {
  it('rejects duplicate and unknown target identifiers', async () => {
    const build = vi.fn().mockResolvedValue(undefined);
    expect(() => new DeferredBuildCoordinator([
      { id: 'worker', build },
      { id: 'worker', build },
    ])).toThrow('Duplicate build target: worker');

    const coordinator = new DeferredBuildCoordinator([{ id: 'worker', build }]);
    expect(() => coordinator.getState('missing')).toThrow('Unknown build target: missing');
    await expect(coordinator.ensure('missing')).rejects.toThrow('Unknown build target: missing');
    expect(() => coordinator.invalidate('missing')).toThrow('Unknown build target: missing');
  });

  it('deduplicates concurrent ensure calls for one target', async () => {
    let resolveBuild: (() => void) | undefined;
    const build = vi.fn(() => new Promise<void>((resolve) => { resolveBuild = resolve; }));
    const coordinator = new DeferredBuildCoordinator([{ id: 'worker', build }]);
    const first = coordinator.ensure('worker');
    const second = coordinator.ensure('worker');
    expect(build).toHaveBeenCalledTimes(1);
    resolveBuild?.();
    await Promise.all([first, second]);
    expect(coordinator.getState('worker')).toBe('ready');
  });

  it('does not let an invalidated build mark a newer generation ready', async () => {
    const resolvers: Array<() => void> = [];
    const build = vi.fn(() => new Promise<void>((resolve) => { resolvers.push(resolve); }));
    const coordinator = new DeferredBuildCoordinator([{ id: 'worker', build }]);
    const stale = coordinator.ensure('worker');
    coordinator.invalidate('worker');
    resolvers.shift()?.();
    await stale;
    expect(coordinator.getState('worker')).toBe('pending');
    const fresh = coordinator.ensure('worker');
    resolvers.shift()?.();
    await fresh;
    expect(build).toHaveBeenCalledTimes(2);
    expect(coordinator.getState('worker')).toBe('ready');
  });

  it('uses XDT_EAGER_WORKERS when eager option is omitted', async () => {
    const previous = process.env.XDT_EAGER_WORKERS;
    process.env.XDT_EAGER_WORKERS = '1';
    try {
      const coordinator = new DeferredBuildCoordinator([]);
      expect(coordinator.isEager).toBe(true);
    } finally {
      if (previous === undefined) {
        delete process.env.XDT_EAGER_WORKERS;
      } else {
        process.env.XDT_EAGER_WORKERS = previous;
      }
    }
  });

  it('allows a failed target to retry', async () => {
    const build = vi.fn().mockRejectedValueOnce(new Error('transient')).mockResolvedValueOnce(undefined);
    const coordinator = new DeferredBuildCoordinator([{ id: 'worker', build }]);
    await expect(coordinator.ensure('worker')).rejects.toThrow('transient');
    expect(coordinator.getState('worker')).toBe('failed');
    await coordinator.ensure('worker');
    expect(build).toHaveBeenCalledTimes(2);
    expect(coordinator.getState('worker')).toBe('ready');
  });

  it('eager mode builds deferred targets during start', async () => {
    const critical = vi.fn().mockResolvedValue(undefined);
    const worker = vi.fn().mockResolvedValue(undefined);
    const coordinator = new DeferredBuildCoordinator([
      { id: 'main', critical: true, build: critical },
      { id: 'worker', build: worker },
    ], { eager: true });
    await coordinator.start();
    expect(critical).toHaveBeenCalledTimes(1);
    expect(worker).toHaveBeenCalledTimes(1);
  });

  it('default mode waits for every critical target before starting deferred builds', async () => {
    let resolveMain: (() => void) | undefined;
    let resolvePreload: (() => void) | undefined;
    const order: string[] = [];
    const main = vi.fn(() => new Promise<void>((resolve) => {
      order.push('main-start');
      resolveMain = () => {
        order.push('main-ready');
        resolve();
      };
    }));
    const preload = vi.fn(() => new Promise<void>((resolve) => {
      order.push('preload-start');
      resolvePreload = () => {
        order.push('preload-ready');
        resolve();
      };
    }));
    const worker = vi.fn(async () => {
      order.push('worker-start');
    });
    const coordinator = new DeferredBuildCoordinator([
      { id: 'main', critical: true, build: main },
      { id: 'preload', critical: true, build: preload },
      { id: 'worker', build: worker },
    ], { eager: false });

    const start = coordinator.start();
    await Promise.resolve();
    expect(order).toEqual(['main-start', 'preload-start']);
    expect(worker).not.toHaveBeenCalled();

    resolveMain?.();
    await Promise.resolve();
    expect(worker).not.toHaveBeenCalled();
    resolvePreload?.();
    await start;

    expect(worker).toHaveBeenCalledTimes(1);
    expect(order.indexOf('worker-start')).toBeGreaterThan(order.indexOf('preload-ready'));
  });

  it('default mode starts critical without waiting for deferred builds', async () => {
    let resolveWorker: (() => void) | undefined;
    const critical = vi.fn().mockResolvedValue(undefined);
    const worker = vi.fn(() => new Promise<void>((resolve) => { resolveWorker = resolve; }));
    const coordinator = new DeferredBuildCoordinator([
      { id: 'main', critical: true, build: critical },
      { id: 'worker', build: worker },
    ], { eager: false });

    await coordinator.start();

    expect(critical).toHaveBeenCalledTimes(1);
    expect(coordinator.getState('main')).toBe('ready');
    expect(worker).toHaveBeenCalledTimes(1);
    expect(coordinator.getState('worker')).toBe('building');

    resolveWorker?.();
    await coordinator.ensure('worker');
    expect(coordinator.getState('worker')).toBe('ready');
  });

  it('ensure shares a deferred build started by start', async () => {
    let resolveWorker: (() => void) | undefined;
    const worker = vi.fn(() => new Promise<void>((resolve) => { resolveWorker = resolve; }));
    const coordinator = new DeferredBuildCoordinator([{ id: 'worker', build: worker }], { eager: false });
    const start = coordinator.start();
    await Promise.resolve();
    const ensured = coordinator.ensure('worker');
    expect(worker).toHaveBeenCalledTimes(1);
    resolveWorker?.();
    await Promise.all([start, ensured]);
    expect(coordinator.getState('worker')).toBe('ready');
  });

  it('does not block start on a failed deferred build and retries it on ensure', async () => {
    let rejectWorker: ((error: Error) => void) | undefined;
    const critical = vi.fn().mockResolvedValue(undefined);
    const worker = vi.fn()
      .mockImplementationOnce(() => new Promise<void>((_resolve, reject) => { rejectWorker = reject; }))
      .mockResolvedValueOnce(undefined);
    const coordinator = new DeferredBuildCoordinator([
      { id: 'main', critical: true, build: critical },
      { id: 'worker', build: worker },
    ], { eager: false });

    await coordinator.start();

    expect(coordinator.getState('main')).toBe('ready');
    expect(coordinator.getState('worker')).toBe('building');
    rejectWorker?.(new Error('background failure'));
    await vi.waitFor(() => expect(coordinator.getState('worker')).toBe('failed'));

    await coordinator.ensure('worker');

    expect(worker).toHaveBeenCalledTimes(2);
    expect(coordinator.getState('worker')).toBe('ready');
  });
});
