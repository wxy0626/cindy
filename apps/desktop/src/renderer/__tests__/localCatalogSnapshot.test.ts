import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProviderView } from '@cindy/model-providers';

const mocks = vi.hoisted(() => ({
  beginCapabilities: vi.fn(),
  commitCapabilities: vi.fn(),
  capabilitiesCurrent: vi.fn(),
  loadCapabilities: vi.fn(),
  beginProviders: vi.fn(),
  commitProviders: vi.fn(),
  providersCurrent: vi.fn(),
  loadProviders: vi.fn(),
  initializeVisibility: vi.fn(),
  warn: vi.fn(),
}));

vi.mock('@/hooks/useAgentCapabilities', () => ({
  beginLocalCapabilitiesRefresh: mocks.beginCapabilities,
  commitLocalCapabilitiesSnapshot: mocks.commitCapabilities,
  isLocalCapabilitiesRefreshCurrent: mocks.capabilitiesCurrent,
  loadLocalCapabilitiesSnapshot: mocks.loadCapabilities,
}));

vi.mock('@/lib/providersSnapshotStore', () => ({
  beginProvidersRefresh: mocks.beginProviders,
  commitProvidersSnapshot: mocks.commitProviders,
  isProvidersRefreshCurrent: mocks.providersCurrent,
  loadProvidersSnapshot: mocks.loadProviders,
}));

vi.mock('@/lib/logger', () => ({
  createLogger: () => ({ warn: mocks.warn }),
}));

vi.mock('@/state/modelVisibilityPrefs', () => ({
  migrateModelVisibilityDefaults: mocks.initializeVisibility,
}));

import { preloadLocalCatalogSnapshot, refreshLocalCatalogSnapshot } from '@/lib/localCatalogSnapshot';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('refreshLocalCatalogSnapshot', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    let providerGeneration = 0;
    let capabilitiesGeneration = 0;
    mocks.beginProviders.mockImplementation(() => ++providerGeneration);
    mocks.beginCapabilities.mockImplementation(() => ++capabilitiesGeneration);
    mocks.providersCurrent.mockReturnValue(true);
    mocks.capabilitiesCurrent.mockReturnValue(true);
    mocks.commitProviders.mockReturnValue(true);
    mocks.commitCapabilities.mockReturnValue(true);
    mocks.initializeVisibility.mockResolvedValue(true);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('keeps the last valid snapshot when any member of the refresh fails', async () => {
    mocks.loadProviders.mockRejectedValueOnce(new Error('provider IPC failed'));
    mocks.loadCapabilities.mockResolvedValueOnce([]);

    await expect(refreshLocalCatalogSnapshot()).resolves.toBe(false);
    expect(mocks.commitProviders).not.toHaveBeenCalled();
    expect(mocks.commitCapabilities).not.toHaveBeenCalled();
    expect(mocks.warn).toHaveBeenCalledOnce();
  });

  it('keeps the last valid snapshot when capabilities loading fails', async () => {
    mocks.loadProviders.mockResolvedValueOnce({ providers: [{ id: 'provider-old' }] });
    mocks.loadCapabilities.mockRejectedValueOnce(new Error('Pi capability IPC failed'));

    await expect(refreshLocalCatalogSnapshot()).resolves.toBe(false);
    expect(mocks.commitProviders).not.toHaveBeenCalled();
    expect(mocks.commitCapabilities).not.toHaveBeenCalled();
    expect(mocks.warn).toHaveBeenCalledOnce();
  });

  it('does not commit capabilities when the provider snapshot owner is stale', async () => {
    const providers = {
      dataOwnerId: 'owner-b',
      ownerGeneration: 2,
      providers: [{ id: 'owner-b-provider' }],
      providerOrder: ['owner-b-provider'],
    };
    mocks.loadProviders.mockResolvedValueOnce(providers);
    mocks.loadCapabilities.mockResolvedValueOnce([]);
    mocks.providersCurrent.mockImplementation((_token, snapshot) => snapshot !== providers);

    await expect(refreshLocalCatalogSnapshot()).resolves.toBe(false);
    expect(mocks.commitProviders).not.toHaveBeenCalled();
    expect(mocks.commitCapabilities).not.toHaveBeenCalled();
  });

  it('drops an older refresh that finishes after a newer generation', async () => {
    const oldProviders = deferred<unknown[]>();
    const oldCapabilities = deferred<unknown[]>();
    const newProviders = deferred<unknown[]>();
    const newCapabilities = deferred<unknown[]>();
    mocks.loadProviders
      .mockReturnValueOnce(oldProviders.promise)
      .mockReturnValueOnce(newProviders.promise);
    mocks.loadCapabilities
      .mockReturnValueOnce(oldCapabilities.promise)
      .mockReturnValueOnce(newCapabilities.promise);

    const oldRefresh = refreshLocalCatalogSnapshot();
    const newRefresh = refreshLocalCatalogSnapshot();
    newProviders.resolve([{ id: 'new-provider' }]);
    newCapabilities.resolve([['codex', { availableModels: [{ id: 'new-model' }] }]]);
    await expect(newRefresh).resolves.toBe(true);

    oldProviders.resolve([{ id: 'old-provider' }]);
    oldCapabilities.resolve([['codex', { availableModels: [{ id: 'old-model' }] }]]);
    await expect(oldRefresh).resolves.toBe(false);

    expect(mocks.commitProviders).toHaveBeenCalledTimes(1);
    expect(mocks.commitProviders.mock.calls[0]?.[1]).toEqual([{ id: 'new-provider' }]);
    expect(mocks.commitCapabilities).toHaveBeenCalledTimes(1);
  });

  it('waits for visibility initialization and rechecks ownership before publishing either snapshot', async () => {
    const initialization = deferred<boolean>();
    const providers = { dataOwnerId: 'owner-a', ownerGeneration: 1, providers: [], providerOrder: [] };
    mocks.loadProviders.mockResolvedValueOnce(providers);
    mocks.loadCapabilities.mockResolvedValueOnce([]);
    mocks.initializeVisibility.mockReturnValueOnce(initialization.promise);
    const refresh = refreshLocalCatalogSnapshot();
    await vi.waitFor(() => expect(mocks.initializeVisibility).toHaveBeenCalledOnce());
    expect(mocks.commitProviders).not.toHaveBeenCalled();
    expect(mocks.commitCapabilities).not.toHaveBeenCalled();
    mocks.providersCurrent.mockReturnValue(false);
    expect(mocks.initializeVisibility.mock.calls[0]?.[3]()).toBe(false);
    initialization.resolve(true);
    await expect(refresh).resolves.toBe(false);
    expect(mocks.commitProviders).not.toHaveBeenCalled();
    expect(mocks.commitCapabilities).not.toHaveBeenCalled();
  });

  it.each([
    ['storage', true], ['lock', true], ['storage', false], ['lock', false],
  ] as const)('propagates real %s initialization failures through preload (recovers: %s)', async (failure, recovers) => {
    vi.useFakeTimers();
    const saved = new Map<string, string>();
    let rejectWrite = false;
    const storage = {
      getItem: (key: string) => saved.get(key) ?? null,
      removeItem: (key: string) => { saved.delete(key); },
      setItem: (key: string, value: string) => {
        if (rejectWrite) throw new Error('storage full');
        saved.set(key, value);
      },
    };
    const sync = vi.fn(async () => undefined);
    let rejectLock = false;
    vi.stubGlobal('navigator', { locks: { request: async (_key: string, run: () => boolean) => {
      if (rejectLock) throw new Error('lock unavailable');
      return run();
    } } });
    vi.stubGlobal('localStorage', storage);
    vi.stubGlobal('window', { localStorage: storage, electronAPI: { maker: {
      syncModelVisibility: sync,
      claimLegacyModelVisibilityOwner: () => ({
        dataOwnerId: 'owner-a', ownerGeneration: 1, canWriteOwnerScoped: true,
        claimed: true, claimedByOtherOwner: false, canInitialize: true, profileOrigin: 'new',
      }),
    } } });
    const prefs = await vi.importActual<typeof import('@/state/modelVisibilityPrefs')>('@/state/modelVisibilityPrefs');
    prefs.__resetForTest();
    try {
      await prefs.setModelVisibilityOwner('owner-a', 1, 'cloud');
      const provider: ProviderView = {
        id: 'xd', name: 'Cindy AI', source: 'builtin', connected: true, agents: ['pi'],
        auth: { method: 'apiKey' }, routing: {}, models: { pi: [{
          id: 'recommended', name: 'Recommended', defaultEnabled: true,
          contextWindow: 200000, efforts: [], defaultEffort: null,
        }] },
      };
      const providers = { dataOwnerId: 'owner-a', ownerGeneration: 1, providers: [provider], providerOrder: ['xd'] };
      mocks.loadProviders.mockResolvedValue(providers);
      mocks.loadCapabilities.mockResolvedValue([['pi', { availableModels: provider.models.pi }]]);
      mocks.initializeVisibility.mockImplementation(prefs.migrateModelVisibilityDefaults);
      rejectWrite = failure === 'storage';
      rejectLock = failure === 'lock';
      const preload = preloadLocalCatalogSnapshot();
      await vi.advanceTimersByTimeAsync(0);
      expect(mocks.loadProviders).toHaveBeenCalledTimes(1);
      expect(mocks.commitProviders).not.toHaveBeenCalled();
      expect(mocks.commitCapabilities).not.toHaveBeenCalled();
      expect(sync).toHaveBeenLastCalledWith('owner-a', 1, {}, expect.objectContaining({ pending: true }));

      if (recovers) { rejectWrite = false; rejectLock = false; }
      await vi.advanceTimersByTimeAsync(1000);
      if (recovers) {
        // 故障源已在快试窗口内恢复：第 2 次尝试（500ms 处）成功提交。
        await preload;
        expect(mocks.loadProviders).toHaveBeenCalledTimes(2);
        expect(mocks.commitProviders).toHaveBeenCalledTimes(1);
        expect(mocks.commitCapabilities).toHaveBeenCalledTimes(1);
        expect(mocks.commitProviders).toHaveBeenLastCalledWith(2, providers);
        expect(sync).toHaveBeenLastCalledWith('owner-a', 1, {},
          expect.not.objectContaining({ pending: true }));
        expect(prefs.isModelEnabled('pi', 'xd', { id: 'recommended' })).toBe(true);
      } else {
        // 快试 3 次全败（0/500/1000ms），此时尚无任何提交，镜像仍标记 pending。
        expect(mocks.loadProviders).toHaveBeenCalledTimes(3);
        expect(mocks.commitProviders).not.toHaveBeenCalled();
        expect(mocks.commitCapabilities).not.toHaveBeenCalled();
        expect(sync).toHaveBeenLastCalledWith('owner-a', 1, {}, expect.objectContaining({ pending: true }));
        // 慢退避语义：恢复故障源后下一次尝试（3000ms 处）应成功提交，而不是像旧
        // 实现那样 3 次后永久放弃（供应商页会一直空到下一次广播）。
        rejectWrite = false;
        rejectLock = false;
        await vi.advanceTimersByTimeAsync(2500);
        await preload;
        expect(mocks.loadProviders).toHaveBeenCalledTimes(4);
        expect(mocks.commitProviders).toHaveBeenCalledTimes(1);
        expect(mocks.commitCapabilities).toHaveBeenCalledTimes(1);
      }
    } finally {
      prefs.__resetForTest();
    }
  });
});
