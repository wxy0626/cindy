// @vitest-environment jsdom

/**
 * UpdateNoticeDialog 的 auto 布局契约。
 *
 * 装完后的自动公告走这条布局,UpdateBanner 的「装前预览」也刻意复用它(见 useUpdateNotice
 * 的 onOpenVersion)。所以这个文件既是既有行为的回归护栏,也是新入口渲染形态的说明:
 *   - 单版本:右上角显示公告版本
 *   - 跨版本:右上角仍显示待读公告的最新版,不随正文滚动变化
 * 两种情况都没有版本跳转器、没有懒加载占位块。
 */

import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { UpdateNoticeDialog } from '@/components/UpdateNoticeDialog';
import type { ReleaseNotes } from '@/release-notes';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) => {
      if (!opts) return key;
      const args = Object.entries(opts).map(([k, v]) => `${k}=${String(v)}`).join(',');
      return `${key}(${args})`;
    },
    i18n: { language: 'zh-CN' },
  }),
}));

function notesFor(version: string, date: string): ReleaseNotes {
  return {
    version,
    date,
    contributors: [],
    sections: [],
    topics: [{ title: `条目 ${version}`, text: '正文。', contributors: [] }],
  };
}

const NEWEST = notesFor('0.1.21', '2026-07-29');
const OLDER = notesFor('0.1.20', '2026-07-20');

beforeEach(() => {
  // jsdom 没有 IntersectionObserver;弹窗内部的懒加载与 sticky 表头都依赖它。
  vi.stubGlobal('IntersectionObserver', class {
    observe() {}
    unobserve() {}
    disconnect() {}
    takeRecords() { return []; }
  });
});

afterEach(() => {
  cleanup();
  delete (window as unknown as { electronAPI?: unknown }).electronAPI;
  vi.unstubAllGlobals();
});

function renderAuto(releaseNotes: ReleaseNotes[]) {
  return render(
    <UpdateNoticeDialog
      open
      mode="auto"
      releaseNotes={releaseNotes}
      allVersions={null}
      loadVersion={vi.fn().mockResolvedValue(null)}
      onDismiss={vi.fn()}
    />,
  );
}

describe('UpdateNoticeDialog auto layout', () => {
  it('single version: version badge in header and content, single-version aria', () => {
    renderAuto([NEWEST]);

    expect(screen.queryByText(/update\.notice\.versionsSpan/)).toBeNull();
    expect(screen.getAllByText(/2026/).length).toBeGreaterThan(0);
    // v0.1.21 同时出现在右上角本机版本徽标和正文版本子标题。
    expect(screen.getAllByText('v0.1.21')).toHaveLength(2);
    expect(
      screen.getByText('update.notice.ariaDescription(version=0.1.21)'),
    ).toBeTruthy();
  });

  it('multiple versions: version badge in header, per-version badges, span aria', () => {
    renderAuto([NEWEST, OLDER]);

    // 不再显示版本数量；右上角显示本机版本，正文按版本分块。
    expect(screen.queryByText(/update\.notice\.versionsSpan/)).toBeNull();
    // v0.1.21 同时出现在右上角本机版本徽标和对应正文块。
    expect(screen.getAllByText('v0.1.21')).toHaveLength(2);
    // v0.1.20 只出现在正文块；右上角固定显示本机版本 v0.1.21。
    expect(screen.getByText('v0.1.20')).toBeTruthy();
    expect(
      screen.getByText('update.notice.ariaDescriptionSpan(from=0.1.20,count=2)'),
    ).toBeTruthy();
  });

  it('header badge shows the upstream notice version instead of the stale local semantic version', () => {
    (window as unknown as { electronAPI: unknown }).electronAPI = {
      appVersion: '0.0.0',
      appSemanticVersion: '0.1.20',
    };

    renderAuto([NEWEST, OLDER]);

    expect(screen.getAllByText('v0.1.21')).toHaveLength(2);
    expect(screen.getByText('v0.1.20')).toBeTruthy();
  });

  it('renders one content block per aggregated version', () => {
    renderAuto([NEWEST, OLDER]);

    expect(screen.getByText('条目 0.1.21')).toBeTruthy();
    expect(screen.getByText('条目 0.1.20')).toBeTruthy();
  });
});
