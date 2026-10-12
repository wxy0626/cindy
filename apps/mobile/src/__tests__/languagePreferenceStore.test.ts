import { beforeEach, describe, expect, it, vi } from 'vitest';

const store = vi.hoisted(() => new Map<string, string>());

vi.mock('@react-native-async-storage/async-storage', () => ({
  default: {
    getItem: vi.fn(async (key: string) => store.get(key) ?? null),
    setItem: vi.fn(async (key: string, value: string) => {
      store.set(key, value);
    }),
    removeItem: vi.fn(async (key: string) => {
      store.delete(key);
    }),
  },
}));

import {
  __testing,
  readLanguagePreference,
  saveLanguagePreference,
} from '@/i18n/languagePreferenceStore';

describe('languagePreferenceStore', () => {
  beforeEach(() => {
    store.clear();
    vi.clearAllMocks();
  });

  it('未存储任何值时读出默认中文', async () => {
    await expect(readLanguagePreference()).resolves.toBe('zh-CN');
  });

  it('保存具体语言后读出该语言', async () => {
    await saveLanguagePreference('en');
    await expect(readLanguagePreference()).resolves.toBe('en');
    expect(store.get(__testing.storageKey)).toBe('en');
  });

  it('历史遗留的 system 值回退中文', async () => {
    store.set(__testing.storageKey, 'system');
    await expect(readLanguagePreference()).resolves.toBe('zh-CN');
  });

  it('存储里出现非法值时回退中文', async () => {
    store.set(__testing.storageKey, 'fr');
    await expect(readLanguagePreference()).resolves.toBe('zh-CN');
  });

  it('历史 ja / ko / zh-TW 偏好回退中文', async () => {
    for (const legacy of ['ja', 'ko', 'zh-TW']) {
      store.set(__testing.storageKey, legacy);
      await expect(readLanguagePreference()).resolves.toBe('zh-CN');
    }
  });
});
