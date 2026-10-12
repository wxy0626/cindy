import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

const expectedDescriptions = {
  'zh-CN': '关闭后仅影响后续新建的任务，不会中止当前 Worker；用于多 Worker 团队编排',
  en: 'Turning it off only affects newly created sessions and does not stop active workers; supports multi-worker team orchestration',
} as const;

describe('built-in tools collaboration description i18n', () => {
  it('states that disabling collaboration only affects newly created sessions', () => {
    for (const [locale, expectedDescription] of Object.entries(expectedDescriptions)) {
      const localeFile = resolve(__dirname, '..', 'i18n', 'locales', locale, 'common.json');
      const translations = JSON.parse(readFileSync(localeFile, 'utf8')) as {
        settings?: { builtinTools?: { plugins?: { collab?: { description?: unknown } } } };
      };

      expect(translations.settings?.builtinTools?.plugins?.collab?.description, locale).toBe(
        expectedDescription,
      );
    }
  });
});
