/**
 * 显示语言偏好存储(AsyncStorage,版本化 key)。
 *
 * 遵循「默认 + override」模型(docs/dev-rules/configuration-and-overrides.md):
 * 只持久化用户显式选择的具体语言;无 override 或历史遗留的 system 值统一回退中文。
 */

import AsyncStorage from '@react-native-async-storage/async-storage';

import {
  DEFAULT_LOCALE,
  isLocalePreference,
  type LocalePreference,
} from './locale';

const STORAGE_KEY = 'xdt-maker.mobile.language-preference.v1';

export async function readLanguagePreference(): Promise<LocalePreference> {
  const raw = await AsyncStorage.getItem(STORAGE_KEY).catch(() => null);
  return isLocalePreference(raw) ? raw : DEFAULT_LOCALE;
}

export async function saveLanguagePreference(
  preference: LocalePreference,
): Promise<void> {
  await AsyncStorage.setItem(STORAGE_KEY, preference).catch(() => undefined);
}

export const __testing = {
  storageKey: STORAGE_KEY,
};
