// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';

const STORAGE_KEY = 'xdt:decision-model-settings:v1';

/**
 * 设置模块在 import 时读取一次 localStorage，因此每个用例都必须重新
 * import，才能验证真实的启动迁移行为。
 */
async function loadSettingsModule() {
  vi.resetModules();
  return import('@/state/decisionModelSettings');
}

describe('decisionModelSettings', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('defaults to a 30% threshold for the four-way Laya choice', async () => {
    const { getDecisionModelSettings } = await loadSettingsModule();

    expect(getDecisionModelSettings().minConfidence).toBe(0.3);
  });

  it('migrates the old 50% default instead of silently skipping every decision', async () => {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        enabled: true,
        endpoint: 'http://127.0.0.1:8765/predict',
        minConfidence: 0.5,
      }),
    );
    const { getDecisionModelSettings } = await loadSettingsModule();

    expect(getDecisionModelSettings().minConfidence).toBe(0.3);
  });

  it('preserves an explicit user-chosen threshold', async () => {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        version: 2,
        enabled: true,
        endpoint: 'http://127.0.0.1:8765/predict',
        minConfidence: 0.65,
      }),
    );
    const { getDecisionModelSettings } = await loadSettingsModule();

    expect(getDecisionModelSettings().minConfidence).toBe(0.65);
  });

  it('restores the 30% default', async () => {
    const { resetDecisionModelSettings } = await loadSettingsModule();

    expect(resetDecisionModelSettings().minConfidence).toBe(0.3);
  });
});
