import { DEFAULT_LOCALE, SUPPORTED_LOCALES, type LocalePreference, type SupportedLocale } from '../../shared/locale';

const LOCALE_STORAGE_KEY = 'language';
let unpersistedPreference: LocalePreference | undefined;

/** 写入显示语言偏好；写入失败时只保留本会话内的偏好，不改变当前生效语言。 */
export function writeStoredLocale(preference: LocalePreference): void {
  try {
    localStorage.setItem(LOCALE_STORAGE_KEY, preference);
    unpersistedPreference = undefined;
  } catch {
    // A blocked storage write must not change this window's effective language.
    unpersistedPreference = preference;
  }
}

/** 本地分支只保留中英双语：历史 'system' 与已移除语言一律回退默认语言。 */
export function readStoredLocale(): LocalePreference {
  if (unpersistedPreference !== undefined) return unpersistedPreference;
  try {
    const raw = localStorage.getItem(LOCALE_STORAGE_KEY);
    if (raw && (SUPPORTED_LOCALES as readonly string[]).includes(raw)) return raw as LocalePreference;
  } catch {
    // Storage may be unavailable in sandboxed windows.
  }
  return DEFAULT_LOCALE;
}

export function effectiveOf(pref: LocalePreference): SupportedLocale {
  return pref;
}

/** Read before providers mount, without React, i18next initialization or IPC. */
export function getEffectiveLocale(): SupportedLocale {
  return effectiveOf(readStoredLocale());
}
