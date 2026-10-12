import { describe, expect, it } from 'vitest';

import { resolvePreferredSystemLocale, resolveSystemLocale } from '../locale';

describe('desktop locale resolution', () => {
  it('将所有中文变体统一归入 zh-CN', () => {
    for (const tag of [
      'zh',
      'zh-CN',
      'zh-Hans',
      'zh-Hans-HK',
      'zh-SG',
      'zh-Hant',
      'zh-TW',
      'zh-HK',
      'zh-MO',
      'zh-Hant-CN',
      'ZH_HANT_TW',
    ]) {
      expect(resolveSystemLocale(tag), tag).toBe('zh-CN');
    }
  });

  it('只保留中英,其它系统语言回退中文', () => {
    expect(resolveSystemLocale('en-US')).toBe('en');
    expect(resolveSystemLocale('fr-FR')).toBe('zh-CN');
    expect(resolvePreferredSystemLocale(['fr-FR', 'zh-Hant-TW', 'en-US'])).toBe('zh-CN');
    expect(resolvePreferredSystemLocale(['fr-FR', 'en-US'])).toBe('en');
    expect(resolvePreferredSystemLocale(['fr-FR'])).toBe('zh-CN');
  });
});
