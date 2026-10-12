/**
 * 本地决策模型设置。
 *
 * 这是设备级设置：Laya 运行在本机回环地址，不能因为切换 Cindy 账号而
 * 改变它的地址或开关状态。首版只保存路由开关、预测地址和最低置信度。
 */

import { useSyncExternalStore } from 'react';

export interface DecisionModelSettings {
  /** 设置结构版本；用于迁移旧版过高默认阈值，不参与推理。 */
  version: number;
  enabled: boolean;
  endpoint: string;
  minConfidence: number;
}

const STORAGE_KEY = 'xdt:decision-model-settings:v1';
const SETTINGS_VERSION = 2;
const DEFAULT_SETTINGS: DecisionModelSettings = {
  version: SETTINGS_VERSION,
  // Cindy 默认使用本机 Laya 做一次新任务路由判断；服务不可用或置信度不足时
  // decideAgentForTask 会返回 null，保持用户当前 Agent，不阻塞正常建会话。
  enabled: true,
  endpoint: 'http://127.0.0.1:8765/predict',
  // Laya 的四分类概率通常接近均匀分布，0.3 才会保留有效路由结果。
  minConfidence: 0.3,
};

let current = read();
const listeners = new Set<() => void>();
let storageListenerInstalled = false;

function normalize(raw: unknown): DecisionModelSettings {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ...DEFAULT_SETTINGS };
  const record = raw as Partial<DecisionModelSettings>;
  const version =
    typeof record.version === 'number' && Number.isFinite(record.version)
      ? record.version
      : 1;
  const minConfidence =
    typeof record.minConfidence === 'number' && Number.isFinite(record.minConfidence)
      ? Math.min(0.95, Math.max(0.3, record.minConfidence))
      : DEFAULT_SETTINGS.minConfidence;
  return {
    version: SETTINGS_VERSION,
    enabled: record.enabled === true,
    endpoint:
      typeof record.endpoint === 'string' && record.endpoint.trim().length > 0
        ? record.endpoint.trim()
        : DEFAULT_SETTINGS.endpoint,
    // v1 的默认 0.5 对四分类 Laya 过高，会让绝大多数首条消息被静默回退。
    // 仅迁移未改过阈值的旧默认值；用户显式保存过的其他值继续保留。
    minConfidence:
      version < SETTINGS_VERSION && record.minConfidence === 0.5
        ? DEFAULT_SETTINGS.minConfidence
        : minConfidence,
  };
}

function read(): DecisionModelSettings {
  if (typeof window === 'undefined') return { ...DEFAULT_SETTINGS };
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    return raw ? normalize(JSON.parse(raw)) : { ...DEFAULT_SETTINGS };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

function emit(): void {
  for (const listener of listeners) listener();
}

function installStorageListener(): void {
  if (storageListenerInstalled || typeof window === 'undefined') return;
  storageListenerInstalled = true;
  window.addEventListener('storage', (event) => {
    if (event.key !== STORAGE_KEY) return;
    current = read();
    emit();
  });
}

export function getDecisionModelSettings(): DecisionModelSettings {
  installStorageListener();
  return current;
}

export function updateDecisionModelSettings(
  patch: Partial<DecisionModelSettings>,
): DecisionModelSettings {
  current = normalize({ ...current, ...patch });
  if (typeof window !== 'undefined') {
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(current));
    } catch {
      // 设置仍保留在当前窗口内存中，无法写盘不阻断新任务。
    }
  }
  emit();
  return current;
}

export function resetDecisionModelSettings(): DecisionModelSettings {
  return updateDecisionModelSettings(DEFAULT_SETTINGS);
}

export function subscribeDecisionModelSettings(listener: () => void): () => void {
  installStorageListener();
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useDecisionModelSettings(): DecisionModelSettings {
  return useSyncExternalStore(
    subscribeDecisionModelSettings,
    getDecisionModelSettings,
    getDecisionModelSettings,
  );
}
