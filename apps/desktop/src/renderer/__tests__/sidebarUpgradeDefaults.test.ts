/**
 * 侧边栏升级兼容性契约(2026-08-12 用户裁决)
 * ---------------------------------------------------------------------------
 * 目标:老用户升级后左侧任务列表的既有配置**尽量不变**,未配置项使用当前默认。
 *   - 分组默认老新一致:按项目 + 按设备 + 对话归组(用户明确要求不分老新)。
 *   - 排序默认按时间;任务信息默认只显示时间。
 *   - 显示模式默认 'text';只有用户显式选过文字 / 列表才保留对应值。
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  loadGroupBy,
  loadGroupDevice,
  loadGroupDialogue,
  loadSortBy,
  loadTaskInfoFields,
  GROUP_DIALOGUE_KEY,
} from '@/features/cc-agent/hooks/helpers/sidebarFilterCore';

/* ------------ in-memory localStorage shim ------------ */

function installMemoryLocalStorage(): Map<string, string> {
  const store = new Map<string, string>();
  const fakeStorage: Storage = {
    get length() {
      return store.size;
    },
    clear() {
      store.clear();
    },
    getItem(key: string) {
      return store.has(key) ? (store.get(key) as string) : null;
    },
    setItem(key: string, value: string) {
      store.set(key, String(value));
    },
    removeItem(key: string) {
      store.delete(key);
    },
    key(idx: number) {
      return Array.from(store.keys())[idx] ?? null;
    },
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (globalThis as any).localStorage = fakeStorage;
  return store;
}

function uninstallLocalStorage(): void {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  delete (globalThis as any).localStorage;
}

/**
 * 主列表显示模式的解析在模块级缓存了内存值,无法在同一进程里反复重置;
 * 这里直接复刻 getSidebarMainViewMode 的判定顺序做契约测试(显式值 > 迁移 >
 * 文字默认),源码侧的接线由 sidebarUpgradeDefaults 的静态断言守住。
 */
function resolveMainViewMode(): 'text' | 'list' {
  const explicit = localStorage.getItem('sidebar.mainListMode');
  if (explicit === 'text' || explicit === 'list') return explicit;
  const legacy = localStorage.getItem('sidebar.cardMode');
  if (legacy === 'text' || legacy === 'false') return 'text';
  if (legacy === 'card' || legacy === 'list' || legacy === 'true') return 'list';
  return 'text';
}

describe('侧边栏升级兼容性:默认配置', () => {
  beforeEach(() => {
    installMemoryLocalStorage();
  });
  afterEach(() => {
    uninstallLocalStorage();
  });

  it('新用户默认:项目 + 设备 + 对话三层分组,按时间排序,任务信息只显示时间', () => {
    expect(loadGroupBy()).toBe('project');
    expect(loadGroupDevice()).toBe(true);
    expect(loadGroupDialogue()).toBe(true);
    expect(loadSortBy()).toBe('recency');
    expect(loadTaskInfoFields()).toEqual(['time']);
  });

  it('分组默认不分老新:老安装拿到同一套分组默认', () => {
    localStorage.setItem('cc-agent.lastChatView.v1', '{"kind":"new"}');
    expect(loadGroupBy()).toBe('project');
    expect(loadGroupDevice()).toBe(true);
    expect(loadGroupDialogue()).toBe(true);
  });

  it('对话归组仍可显式关闭(默认翻转后 false 必须仍被尊重)', () => {
    localStorage.setItem(GROUP_DIALOGUE_KEY, 'false');
    expect(loadGroupDialogue()).toBe(false);
  });
});

describe('显示模式:默认文字,显式选择优先', () => {
  beforeEach(() => {
    installMemoryLocalStorage();
  });
  afterEach(() => {
    uninstallLocalStorage();
  });

  it('没有显式选择 → 文字视图', () => {
    expect(resolveMainViewMode()).toBe('text');
  });

  it('仅有旧版使用痕迹 → 仍是文字视图', () => {
    localStorage.setItem('cc-agent.lastChatView.v1', '{"kind":"new"}');
    expect(resolveMainViewMode()).toBe('text');
  });

  it('老用户显式设过 cardMode:仍按旧值迁移,不受安装新旧影响', () => {
    localStorage.setItem('cc-agent.lastChatView.v1', '{"kind":"new"}');
    localStorage.setItem('sidebar.cardMode', 'card');
    expect(resolveMainViewMode()).toBe('list');
  });

  it('显式设过主列表模式时,安装新旧不参与判定', () => {
    localStorage.setItem('cc-agent.lastChatView.v1', '{"kind":"new"}');
    localStorage.setItem('sidebar.mainListMode', 'list');
    expect(resolveMainViewMode()).toBe('list');
  });

  // 上面的用例复刻了判定顺序(源码里的内存 SoT 无法在同进程反复重置),
  // 这条静态断言保证源码确实按同一顺序接线,两者不脱钩。
  it('源码接线:显式值 → cardMode 迁移 → 文字兜底', () => {
    const source = readFileSync(resolve(__dirname, '..', 'hooks', 'useSidebarCardMode.ts'), 'utf8');
    const explicitIdx = source.indexOf('parseMainMode(localStorage.getItem(MAIN_STORAGE_KEY))');
    // 注意 'parseMode(' 是 'parseMainMode(' 的子串,必须带 const legacy = 前缀定位。
    const legacyIdx = source.indexOf('const legacy = parseMode(localStorage.getItem(STORAGE_KEY))');
    expect(explicitIdx).toBeGreaterThanOrEqual(0);
    expect(legacyIdx).toBeGreaterThan(explicitIdx);
    expect(source).toContain("const DEFAULT_MAIN_MODE: SidebarMainViewMode = 'text'");
  });
});
