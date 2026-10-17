import { describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  app: {
    getPreferredSystemLanguages: () => ['en'],
    getLocale: () => 'en',
  },
}));

import { setMainLocale } from '../i18n';
import {
  getSessionExternalNotificationText,
  getSessionNotificationBody,
  getSessionNotificationUntitled,
  getTeammateNotificationFallback,
} from '../sessionNotificationCopy';
import type { SupportedLocale } from '../../shared/locale';

const CASES: Array<{
  locale: SupportedLocale;
  title: string;
  untitled: string;
  done: string;
  error: string;
  needsReply: string;
  externalDone: string;
  externalError: string;
  externalNeedsReply: string;
}> = [
  {
    locale: 'zh-CN',
    title: '整理报告',
    untitled: '未命名任务',
    done: '已完成 ✓',
    error: '执行失败',
    needsReply: '需要你回复',
    externalDone: 'Watchdog · 任务「整理报告」已完成 ✓',
    externalError: 'Watchdog · 任务「整理报告」执行失败',
    externalNeedsReply: 'Watchdog · 任务「整理报告」需要你回复',
  },
  {
    locale: 'en',
    title: 'Report',
    untitled: 'Untitled session',
    done: 'Completed ✓',
    error: 'Failed',
    needsReply: 'Reply needed',
    externalDone: 'Watchdog · Session “Report” completed ✓',
    externalError: 'Watchdog · Session “Report” failed',
    externalNeedsReply: 'Watchdog · Session “Report” needs your reply',
  },
];

describe('session notification copy', () => {
  it.each(CASES)('$locale 使用当前语言生成三种状态与外部通知', (entry) => {
    setMainLocale(entry.locale);

    expect(getSessionNotificationUntitled()).toBe(entry.untitled);
    expect(getSessionNotificationBody('done')).toBe(entry.done);
    expect(getSessionNotificationBody('error')).toBe(entry.error);
    expect(getSessionNotificationBody('needs-reply')).toBe(entry.needsReply);
    expect(getSessionExternalNotificationText(entry.title, 'done')).toBe(entry.externalDone);
    expect(getSessionExternalNotificationText(entry.title, 'error')).toBe(entry.externalError);
    expect(getSessionExternalNotificationText(entry.title, 'needs-reply')).toBe(
      entry.externalNeedsReply,
    );
  });

  it('运行时切换语言后下一条通知立即跟随', () => {
    setMainLocale('en');
    expect(getSessionNotificationBody('needs-reply')).toBe('Reply needed');
    setMainLocale('zh-CN');
    expect(getSessionNotificationBody('needs-reply')).toBe('需要你回复');
  });

  it.each(['foo$&bar', 'foo$`bar', "foo$'bar", 'foo$$bar'])(
    '将包含 JavaScript replacement token 的标题 %s 原样插入三种外部通知',
    (title) => {
      setMainLocale('en');
      expect(getSessionExternalNotificationText(title, 'done')).toBe(
        `Watchdog · Session “${title}” completed ✓`,
      );
      expect(getSessionExternalNotificationText(title, 'error')).toBe(
        `Watchdog · Session “${title}” failed`,
      );
      expect(getSessionExternalNotificationText(title, 'needs-reply')).toBe(
        `Watchdog · Session “${title}” needs your reply`,
      );
    },
  );
});


it.each([
  ['en', 'New reply'], ['zh-CN', '有新回复'],
] as const)('uses the current %s locale for a reply with no preview', (locale, expected) => {
  setMainLocale(locale);
  expect(getTeammateNotificationFallback()).toBe(expected);
});
