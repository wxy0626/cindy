/**
 * 本地 provider catalog 的 renderer 原子刷新协调器。
 *
 * providers 与核心 agent capabilities 必须来自同一轮 main 快照：核心 IPC 全部成功、
 * 且期间没有更新一代目录时才同步提交。明确未注册的可选 Pi 可从快照中省略；其它失败
 * 或乱序结果一律保留上一份有效快照。
 * device-link 的远端 capabilities 不经过这里，继续按 deviceId 独立缓存。
 */
import { createLogger } from '@/lib/logger';
import { migrateModelVisibilityDefaults } from '@/state/modelVisibilityPrefs';
import {
  beginLocalCapabilitiesRefresh,
  commitLocalCapabilitiesSnapshot,
  isLocalCapabilitiesRefreshCurrent,
  loadLocalCapabilitiesSnapshot,
} from '@/hooks/useAgentCapabilities';
import {
  beginProvidersRefresh,
  commitProvidersSnapshot,
  isProvidersRefreshCurrent,
  loadProvidersSnapshot,
} from '@/lib/providersSnapshotStore';

const log = createLogger('localCatalogSnapshot');
let refreshGeneration = 0;

/** 联合刷新 providers + 可用 agent capabilities，并只提交最新的完整结果。 */
export async function refreshLocalCatalogSnapshot(): Promise<boolean> {
  const generation = ++refreshGeneration;
  const providersGeneration = beginProvidersRefresh();
  const capabilitiesGeneration = beginLocalCapabilitiesRefresh();

  try {
    const [providers, capabilities] = await Promise.all([
      loadProvidersSnapshot(),
      loadLocalCapabilitiesSnapshot(),
    ]);
    const isCurrent = (): boolean => refreshGeneration === generation
      && isProvidersRefreshCurrent(providersGeneration, providers)
      && isLocalCapabilitiesRefreshCurrent(capabilitiesGeneration);
    if (!isCurrent()) return false;
    const initialized = await migrateModelVisibilityDefaults(providers.dataOwnerId, providers.ownerGeneration, providers.providers, isCurrent);
    // Failed persistence/locking must reach preload's retry loop. Waiting for another
    // renderer's preference write must not publish a stale catalog either.
    if (!initialized || !isCurrent()) return false;

    // 两次提交均为同步通知；React 会把同一事件循环内的 hook 更新批处理到同一帧。
    commitLocalCapabilitiesSnapshot(capabilitiesGeneration, capabilities);
    commitProvidersSnapshot(providersGeneration, providers);
    return true;
  } catch (error) {
    if (refreshGeneration === generation) {
      log.warn('local catalog snapshot refresh failed; keeping last valid snapshot', error);
    }
    return false;
  }
}

/** 启动预热重试上限：3 次快试后转入慢退避，覆盖启动窗口内最长的阻塞阶段。 */
const PRELOAD_MAX_ATTEMPTS = 40;

/**
 * 启动预热：前 3 次 500ms 快试保留原语义，之后转 2s 慢退避直到首个完整快照提交。
 *
 * 启动窗口内 owner boundary 结算、账号迁移（activeOwnerMigrationPending）与本地 DB 门
 * 就绪都可能阻塞 30s 以上，快试全败不代表异常；此前 3 次后永久放弃，一旦错过窗口
 * 供应商页会停在空列表，直到下一次目录广播（可能永远不来）。成功即返回；达上限才告警。
 */
export async function preloadLocalCatalogSnapshot(): Promise<void> {
  for (let attempt = 0; attempt < PRELOAD_MAX_ATTEMPTS; attempt += 1) {
    if (await refreshLocalCatalogSnapshot()) return;
    // 前 3 次 500ms 快试；之后 2s 慢退避，等 owner 迁移与本地 DB 门就绪。
    const delayMs = attempt < 2 ? 500 : 2000;
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
  log.warn('local catalog snapshot preload gave up after repeated attempts');
}
