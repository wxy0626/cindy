/**
 * useLocale —— 显示语言偏好 + 实际生效语言。
 *
 * 设计上和 useTheme 镜像：
 *   - 偏好持久化在 localStorage (key='language')，不经 server。
 *   - 未设置偏好或非法值统一回退中文。
 *   - 切换语言时同步 i18next.changeLanguage 触发 react-i18next 重渲染，
 *     同步 <html lang="...">，并通知 main 刷新 macOS 原生菜单文案。
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import { createElement } from 'react';

import {
  i18n,
  DEFAULT_LOCALE,
  isLocalePreference,
  type LocalePreference,
  type SupportedLocale,
} from '@/i18n';

interface LocaleContextValue {
  /** 用户的显示语言偏好。 */
  locale: LocalePreference;
  /** 实际生效的语言；当前与偏好相同。 */
  effectiveLocale: SupportedLocale;
  /** 设置偏好 —— 持久化到 localStorage、刷 i18next、刷 <html lang>。 */
  setLocale: (next: SupportedLocale) => void;
}

const STORAGE_KEY = 'language';
const LocaleContext = createContext<LocaleContextValue | undefined>(undefined);

function readStoredLocale(): LocalePreference {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw && isLocalePreference(raw)) return raw;
  } catch {
    // localStorage 不可用 (例如 SSR / 沙箱) 时静默回退
  }
  return DEFAULT_LOCALE;
}

function syncApplicationMenuLocale(loc: SupportedLocale): void {
  if (typeof window === 'undefined') return;
  void window.electronAPI?.setApplicationMenuLocale?.(loc).catch(() => {
    /* Native app menu is macOS-only; renderer locale still updates normally. */
  });
}

function applyLocale(loc: SupportedLocale): void {
  // i18next 自带 isInitialized 检查；同步资源 + 同步 init 下永远是 true。
  void i18n.changeLanguage(loc);
  if (typeof document !== 'undefined') {
    document.documentElement.lang = loc;
  }
  syncApplicationMenuLocale(loc);
}

/**
 * Apply the persisted locale before the first React render.
 *
 * Lightweight windows render their error boundary outside the provider tree;
 * initializing i18next synchronously here keeps even an early render failure
 * in the user's selected language.
 */
export function bootstrapInitialLocale(): SupportedLocale {
  const effectiveLocale = readStoredLocale();
  applyLocale(effectiveLocale);
  return effectiveLocale;
}

export function LocaleProvider({ children }: { children: ReactNode }) {
  const [locale, setLocaleState] = useState<LocalePreference>(readStoredLocale);
  const [effectiveLocale, setEffectiveLocale] = useState<SupportedLocale>(readStoredLocale);

  const setLocale = useCallback((next: SupportedLocale) => {
    // 兼容子窗口广播或历史运行态传来的旧语言值；可持久化偏好仍只有中英。
    const preference = isLocalePreference(next) ? next : DEFAULT_LOCALE;
    setLocaleState(preference);
    try {
      localStorage.setItem(STORAGE_KEY, preference);
    } catch {
      // 持久化失败不影响当前会话切换
    }
    setEffectiveLocale(preference);
    applyLocale(preference);
  }, []);

  // 首次 mount 时确保 i18next + <html lang> 与 state 一致 (state 来自 localStorage,
  // 而 i18n.init 默认用的是 DEFAULT_LOCALE，两者可能不同)。
  // 仅 mount 一次：locale 后续变化都走 setLocale 路径。
  useEffect(() => {
    applyLocale(effectiveLocale);
  }, [effectiveLocale]);

  const value = useMemo<LocaleContextValue>(
    () => ({ locale, effectiveLocale, setLocale }),
    [locale, effectiveLocale, setLocale],
  );

  return createElement(LocaleContext.Provider, { value }, children);
}

export function useLocale(): LocaleContextValue {
  const ctx = useContext(LocaleContext);
  if (ctx === undefined) {
    throw new Error('useLocale must be used within a LocaleProvider');
  }
  return ctx;
}
