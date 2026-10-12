import { beforeEach, describe, expect, it } from "vitest";

import { setManualLocaleOverride } from "@/i18n/appLanguage";

import {
  newSessionMessages,
  newSessionText,
  resolveNewSessionLocale,
  type NewSessionLocale,
} from "@/session/newSessionMessages";

const LOCALES: NewSessionLocale[] = ["zh-CN", "en"];

describe("newSessionMessages", () => {
  beforeEach(() => {
    setManualLocaleOverride(null);
  });

  it("keeps both locale catalogs key-aligned and non-empty", () => {
    const baseKeys = Object.keys(newSessionMessages["zh-CN"]).sort();
    expect(Object.keys(newSessionMessages).sort()).toEqual([...LOCALES].sort());

    for (const locale of LOCALES) {
      const catalog = newSessionMessages[locale];
      expect(Object.keys(catalog).sort(), `locale=${locale}`).toEqual(baseKeys);
      for (const [key, value] of Object.entries(catalog)) {
        expect(value.trim(), `locale=${locale} key=${key}`).not.toBe("");
      }
    }
  });

  it("maps supported system languages and falls back to Chinese", () => {
    expect(resolveNewSessionLocale("zh-Hant-TW")).toBe("zh-CN");
    expect(resolveNewSessionLocale("en-US")).toBe("en");
    expect(resolveNewSessionLocale("ja-JP")).toBe("zh-CN");
    expect(resolveNewSessionLocale("ko-KR")).toBe("zh-CN");
    expect(resolveNewSessionLocale("fr-FR")).toBe("zh-CN");
  });

  it("defaults to Chinese and follows an explicit language override", () => {
    expect(newSessionText("emptyDirectory")).toBe("没有可显示的子目录。");

    setManualLocaleOverride("en");
    expect(newSessionText("showHiddenDirectories")).toBe("Show Hidden Folders");
    expect(newSessionText("emptyDirectory")).toBe("No folders to show.");
  });
});
