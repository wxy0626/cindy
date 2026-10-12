/**
 * release-notes 归一化单测(更新公告 topic 格式 v2)。
 * 守住:legacy 作者分组 payload 展开为 flat items 且 topics 为空数组;
 * v2 payload 的 topics/intro 透传、缺 sections 不炸;畸形 topic 条目被丢弃
 * 而不是让弹窗崩溃。模块级缓存:每个用例 vi.resetModules() + 动态 import。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

beforeEach(() => {
  vi.resetModules();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function stubFetch(payload: unknown) {
  const fetchReleaseNotes = vi.fn(async () => payload);
  vi.stubGlobal('window', { electronAPI: { fetchReleaseNotes } });
  return fetchReleaseNotes;
}

describe('release-notes normalization', () => {
  it('current fetch 对齐实际版本缓存,不污染显式历史版本请求', async () => {
    const fetchReleaseNotes = vi.fn(async (version: string, resolveLatest?: boolean) => ({
      version: resolveLatest ? '0.1.95' : version,
      date: '2026-09-29',
      topics: [{ title: `${version}:${String(resolveLatest)}`, text: '正文。' }],
    }));
    vi.stubGlobal('window', { electronAPI: { fetchReleaseNotes } });

    const mod = await import('@/release-notes');
    const current = await mod.fetchCurrentReleaseNotes('0.1.86');
    const historical = await mod.fetchReleaseNotes('0.1.86');

    expect(current?.version).toBe('0.1.95');
    expect(historical?.version).toBe('0.1.86');
    expect(fetchReleaseNotes).toHaveBeenNthCalledWith(1, '0.1.86', true);
    expect(fetchReleaseNotes).toHaveBeenNthCalledWith(2, '0.1.86', false);
  });

  it('legacy payload:sections 按作者组展开,topics 归一为空数组', async () => {
    stubFetch({
      version: '0.1.17',
      date: '2026-07-27',
      contributors: ['Lizi'],
      sections: [
        {
          title: 'Bug Fixes',
          items: [{ name: 'Lizi', list: ['修复 A', '修复 B'] }],
        },
      ],
    });
    const mod = await import('@/release-notes');
    const notes = await mod.fetchReleaseNotes('0.1.17');
    expect(notes?.sections[0]?.items).toEqual([
      { text: '修复 A', by: 'Lizi' },
      { text: '修复 B', by: 'Lizi' },
    ]);
    expect(notes?.topics).toEqual([]);
    expect(notes?.intro).toBeUndefined();
  });

  it('v2 payload:topics/intro 透传,缺 sections 归一为空数组', async () => {
    stubFetch({
      version: '0.1.18',
      date: '2026-07-28',
      contributors: ['Lizi', 'Kmny'],
      intro: '本次合并 64 个 PR。',
      topics: [
        {
          emoji: '🎙️',
          title: '语音输入更稳',
          text: '麦克风保活逻辑重写,后台麦克风不再意外残留。',
          contributors: ['Lizi'],
        },
      ],
    });
    const mod = await import('@/release-notes');
    const notes = await mod.fetchReleaseNotes('0.1.18');
    expect(notes?.sections).toEqual([]);
    expect(notes?.intro).toBe('本次合并 64 个 PR。');
    expect(notes?.topics).toEqual([
      {
        emoji: '🎙️',
        title: '语音输入更稳',
        text: '麦克风保活逻辑重写,后台麦克风不再意外残留。',
        contributors: ['Lizi'],
      },
    ]);
  });

  it('同一版本按支持语言选择对应内容,raw payload 只请求一次', async () => {
    const fetchReleaseNotes = stubFetch({
      version: '0.1.23',
      date: '2026-08-06',
      contributors: ['Lizi'],
      topics: [{ id: 'voice', title: '顶层中文', text: '兼容正文。' }],
      contentByLocale: Object.fromEntries(
        ['zh-CN', 'en'].map((locale) => [
          locale,
          {
            intro: `intro-${locale}`,
            topics: [
              {
                id: 'voice',
                emoji: '🎙️',
                title: `title-${locale}`,
                text: `text-${locale}`,
                contributors: ['Lizi'],
              },
            ],
          },
        ]),
      ),
    });
    const mod = await import('@/release-notes');

    for (const locale of ['zh-CN', 'en'] as const) {
      const notes = await mod.fetchReleaseNotes('0.1.23', locale);
      expect(notes?.intro).toBe(`intro-${locale}`);
      expect(notes?.topics[0]).toMatchObject({
        id: 'voice',
        title: `title-${locale}`,
        text: `text-${locale}`,
      });
    }
    expect(fetchReleaseNotes).toHaveBeenCalledTimes(1);
  });

  it('同一版本并发选择不同语言时也只跨 IPC 请求一次 raw payload', async () => {
    let resolveRaw!: (value: unknown) => void;
    const rawPromise = new Promise<unknown>((resolve) => {
      resolveRaw = resolve;
    });
    const fetchReleaseNotes = vi.fn(() => rawPromise);
    vi.stubGlobal('window', { electronAPI: { fetchReleaseNotes } });
    const mod = await import('@/release-notes');

    const english = mod.fetchReleaseNotes('0.1.28', 'en');
    const chinese = mod.fetchReleaseNotes('0.1.28', 'zh-CN');
    expect(fetchReleaseNotes).toHaveBeenCalledTimes(1);

    resolveRaw({
      version: '0.1.28',
      date: '2026-08-06',
      contentByLocale: {
        en: { topics: [{ id: 'same', title: 'English', text: 'English text.' }] },
        'zh-CN': { topics: [{ id: 'same', title: '简体中文', text: '简体中文正文。' }] },
      },
    });

    await expect(english).resolves.toMatchObject({ topics: [{ title: 'English' }] });
    await expect(chinese).resolves.toMatchObject({ topics: [{ title: '简体中文' }] });
    expect(fetchReleaseNotes).toHaveBeenCalledTimes(1);
  });

  it('指定语言的 localized 块畸形时继续回退到可用语言', async () => {
    stubFetch({
      version: '0.1.24',
      date: '2026-08-06',
      contentByLocale: {
        'zh-CN': { topics: [{ title: '本地中文', text: 'localized-zh' }] },
        en: { topics: [{ title: '   ', text: '' }] },
      },
    });
    const mod = await import('@/release-notes');

    // en 块纯空白视为缺失 → 回退到 zh-CN
    expect((await mod.fetchReleaseNotes('0.1.24', 'en'))?.topics[0]?.text).toBe('localized-zh');
    expect((await mod.fetchReleaseNotes('0.1.24', 'zh-CN'))?.topics[0]?.text).toBe('localized-zh');
  });

  it('localized block 为 null 或非对象时按缺失处理并继续 fallback', async () => {
    const fetchReleaseNotes = stubFetch({
      version: '0.1.29',
      date: '2026-08-06',
      topics: [{ title: '顶层中文', text: 'legacy-root' }],
      contentByLocale: {
        en: null,
        'zh-CN': 'not-an-object',
      },
    });
    const mod = await import('@/release-notes');

    // 两个 localized 块都不可用 → 回退顶层旧格式，且 raw payload 只请求一次
    expect((await mod.fetchReleaseNotes('0.1.29', 'en'))?.topics[0]?.text).toBe('legacy-root');
    expect(fetchReleaseNotes).toHaveBeenCalledTimes(1);
  });

  it('英文缺失时回退中文,中文 localized 缺失时直接回退顶层中文', async () => {
    stubFetch({
      version: '0.1.25',
      date: '2026-08-06',
      topics: [{ title: '顶层中文', text: 'legacy-root' }],
      contentByLocale: {
        'zh-CN': { topics: [{ title: '本地中文', text: 'localized-zh' }] },
      },
    });
    const mod = await import('@/release-notes');

    // 请求 en 但只有 zh-CN 块 → 回退 zh-CN
    expect((await mod.fetchReleaseNotes('0.1.25', 'en'))?.topics[0]?.text).toBe('localized-zh');

    vi.resetModules();
    stubFetch({
      version: '0.1.26',
      date: '2026-08-06',
      topics: [{ title: '顶层中文', text: 'legacy-root' }],
      contentByLocale: {
        en: { topics: [{ title: 'English', text: 'localized-en' }] },
      },
    });
    const zhMod = await import('@/release-notes');
    // 请求 zh-CN 但只有 en 块 → 回退顶层旧格式
    expect((await zhMod.fetchReleaseNotes('0.1.26', 'zh-CN'))?.topics[0]?.text).toBe('legacy-root');
  });

  it('localized legacy sections 也能被选择和归一化', async () => {
    stubFetch({
      version: '0.1.27',
      date: '2026-08-06',
      contentByLocale: {
        en: {
          sections: [
            {
              title: 'Bug Fixes',
              items: [{ name: 'A', list: ['Fixed'] }],
            },
          ],
        },
      },
    });
    const mod = await import('@/release-notes');
    const notes = await mod.fetchReleaseNotes('0.1.27', 'en');
    expect(notes?.sections).toEqual([
      { title: 'Bug Fixes', items: [{ text: 'Fixed', by: 'A' }] },
    ]);
  });

  it('畸形 topic 条目被丢弃,合法条目补默认值', async () => {
    stubFetch({
      version: '0.1.19',
      date: '2026-07-29',
      contributors: [],
      topics: [
        { title: '只有标题没有正文' },
        { title: '   ', text: '标题是纯空白' },
        { title: '正文是纯空白', text: '' },
        { emoji: 42, title: '正常主题', text: '正文。', contributors: ['A', 7, 'B'] },
        'not-an-object',
      ],
    });
    const mod = await import('@/release-notes');
    const notes = await mod.fetchReleaseNotes('0.1.19');
    expect(notes?.topics).toEqual([
      { emoji: undefined, title: '正常主题', text: '正文。', contributors: ['A', 'B'] },
    ]);
  });

  it('legacy payload 的畸形 section/作者组/条目被丢弃而不是抛异常', async () => {
    stubFetch({
      version: '0.1.21',
      date: '2026-07-31',
      contributors: ['A', 42, null],
      sections: [
        { title: 'Bug Fixes' }, // 缺 items
        { items: [{ name: 'X', list: ['x'] }] }, // 缺 title
        {
          title: 'New Features',
          items: [
            { name: 'A', list: ['正常条目', 7, null] },
            { name: 'B' }, // 缺 list
            'not-a-group',
          ],
        },
      ],
    });
    const mod = await import('@/release-notes');
    const notes = await mod.fetchReleaseNotes('0.1.21');
    expect(notes?.contributors).toEqual(['A']);
    expect(notes?.sections).toEqual([
      { title: 'New Features', items: [{ text: '正常条目', by: 'A' }] },
    ]);
  });

  it('无任何可渲染内容(全部 topic 畸形且无 sections)按拉取失败处理', async () => {
    const fetchReleaseNotes = stubFetch({
      version: '0.1.20',
      date: '2026-07-30',
      contributors: ['A'],
      topics: [{ title: '只有标题', body: '字段名写错了' }],
    });
    const mod = await import('@/release-notes');
    expect(await mod.fetchReleaseNotes('0.1.20')).toBeNull();
    // 不缓存失败结果:同版本再次调用要重新发起请求,修复后的 CDN payload 可以生效。
    expect(await mod.fetchReleaseNotes('0.1.20')).toBeNull();
    expect(fetchReleaseNotes).toHaveBeenCalledTimes(2);
  });
});
