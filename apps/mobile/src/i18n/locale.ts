/**
 * 移动端 locale 常量与解析纯函数(与 desktop shared/locale.ts 保持一致)。
 *
 * 本模块保持零依赖(不 import expo / RN):偏好存储及其测试直接消费。
 * 只区分中文和英文；其它系统语言统一回退默认中文。
 * 刻意用字符串前缀而非 Intl.Locale——Hermes 的 Intl 子集在各版本间能力不齐,
 * 前缀匹配对当前支持的语言足够且行为可预期。
 */

/** 应用支持的显示语言。只保留中文和英文，不保留历史语言。 */
export const SUPPORTED_LOCALES = ["zh-CN", "en"] as const;
export type SupportedLocale = (typeof SUPPORTED_LOCALES)[number];

export type LocalePreference = SupportedLocale;

/** 缺 key / 未设置偏好 / 历史非法值时的默认语言(与 desktop 一致)。 */
export const DEFAULT_LOCALE = "zh-CN" satisfies SupportedLocale;

export function isSupportedLocale(value: unknown): value is SupportedLocale {
  return (
    typeof value === "string" &&
    (SUPPORTED_LOCALES as readonly string[]).includes(value)
  );
}

export function isLocalePreference(value: unknown): value is LocalePreference {
  return (
    typeof value === "string" &&
    (SUPPORTED_LOCALES as readonly string[]).includes(value)
  );
}

/** BCP 47 languageTag → 支持的 locale。大小写不敏感,null/undefined 兜底中文。 */
export function resolveSystemLocale(
  languageTag: string | null | undefined,
): SupportedLocale {
  const tag = languageTag?.trim().toLowerCase().replace(/_/g, "-") ?? "";
  if (tag.startsWith("zh")) return "zh-CN";
  if (tag.startsWith("en")) return "en";
  return DEFAULT_LOCALE;
}
