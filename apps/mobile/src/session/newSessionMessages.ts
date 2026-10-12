import { getManualLocaleOverride } from "@/i18n/appLanguage";
import {
  DEFAULT_LOCALE,
  resolveSystemLocale,
  type SupportedLocale,
} from "@/i18n/locale";

export type NewSessionLocale = SupportedLocale;

const messages = {
  "zh-CN": {
    showHiddenDirectories: "显示隐藏文件夹",
    emptyDirectory: "没有可显示的子目录。",
  },
  en: {
    showHiddenDirectories: "Show Hidden Folders",
    emptyDirectory: "No folders to show.",
  },
} as const;

export type NewSessionMessageKey = keyof (typeof messages)["zh-CN"];

export const newSessionMessages: Record<
  NewSessionLocale,
  Record<NewSessionMessageKey, string>
> = messages;

/** 将系统语言映射到新建任务界面支持的语言；未覆盖语言回退默认中文。 */
export function resolveNewSessionLocale(
  languageTag: string | null | undefined,
): NewSessionLocale {
  return resolveSystemLocale(languageTag);
}

export function newSessionText(key: NewSessionMessageKey): string {
  // 设置里的手动语言选择优先,未选择时使用默认中文。
  const locale = getManualLocaleOverride() ?? DEFAULT_LOCALE;
  return newSessionMessages[locale][key];
}
