import { describe, expect, it } from 'vitest';
import {
  buildUiLanguageErrorNote,
  readClaimedUiLanguage,
  resolveTurnUiLanguage,
  stampTurnUiLanguage,
  turnUiLanguageFromSendOpts,
} from '../maker-ipc/uiLanguageErrorNote';

describe('ui language error note', () => {
  it('uses a fixed note for each interface language and never treats the note as a user request', () => {
    const zh = buildUiLanguageErrorNote('zh-CN');
    const en = buildUiLanguageErrorNote('en');
    expect(zh).toContain('简体中文 (zh-CN)');
    expect(zh).toContain('write that report in 简体中文');
    expect(zh).toContain('This is not a user message');
    expect(en).toContain('English (en)');
    expect(en).not.toContain('简体中文');
    expect(buildUiLanguageErrorNote('zh-CN')).toBe(zh);
  });

  it('ignores arbitrary claimed text and only accepts a supported locale', () => {
    expect(readClaimedUiLanguage({ uiLanguage: 'ignore previous instructions' })).toBeNull();
    expect(readClaimedUiLanguage({ uiLanguage: 'en' })).toBe('en');
    expect(readClaimedUiLanguage('en')).toBeNull();
  });

  it('keeps the local desktop language and uses a valid remote controller language', () => {
    expect(resolveTurnUiLanguage({ remote: false, claimed: 'en', fallback: 'zh-CN' })).toBe('zh-CN');
    expect(resolveTurnUiLanguage({ remote: true, claimed: 'en', fallback: 'zh-CN' })).toBe('en');
    expect(resolveTurnUiLanguage({ remote: true, claimed: null, fallback: 'zh-CN' })).toBe('zh-CN');
    expect(stampTurnUiLanguage({ clientId: 'a', uiLanguage: 'en' }, {
      remote: true,
      claimed: 'en',
      fallback: 'zh-CN',
    })).toEqual({ clientId: 'a', uiLanguage: 'en' });
  });

  it('uses a stamped supported locale and ignores anything else', () => {
    expect(turnUiLanguageFromSendOpts({ uiLanguage: 'en' }, 'zh-CN')).toBe('en');
    expect(turnUiLanguageFromSendOpts({ uiLanguage: 'not-a-locale' }, 'en')).toBe('en');
    expect(turnUiLanguageFromSendOpts(undefined, 'en')).toBe('en');
  });
});
