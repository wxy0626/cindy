import { afterEach, describe, expect, it } from "vitest";

/**
 * 登录域中英 catalog 测试(zh-CN/en)：
 * key 全集一致非空、placeholder 逐语一致、显式 override 优先、
 * 默认中文兜底。系统 locale 纯函数仍单独保留覆盖。
 */
import { setManualLocaleOverride } from "@/i18n/appLanguage";
import {
  authErrorMessages,
  authErrorText,
  getAuthLocale,
  loginMessages,
  loginText,
  resolveLoginLocale,
  type LoginLocale,
} from "@/auth/loginMessages";
import { LOGIN_CONSENT_DIALOG } from "@/auth/loginSkinLayout";

const LOCALES: LoginLocale[] = ["zh-CN", "en"];

describe("loginMessages 中英 catalog", () => {
  it("catalog 覆盖全部支持 locale", () => {
    expect(Object.keys(loginMessages).sort()).toEqual([...LOCALES].sort());
  });

  it("中英 key 全集一致且值非空", () => {
    const baseKeys = Object.keys(loginMessages["zh-CN"]).sort();
    expect(baseKeys.length).toBeGreaterThan(0);
    for (const locale of LOCALES) {
      const catalog = loginMessages[locale];
      expect(Object.keys(catalog).sort(), `locale=${locale} key 集`).toEqual(
        baseKeys,
      );
      for (const [key, value] of Object.entries(catalog)) {
        expect(value.trim(), `locale=${locale} key=${key} 不得为空`).not.toBe(
          "",
        );
      }
    }
  });

  it("placeholder 逐语一致({email}/{org}/{reason})", () => {
    for (const locale of LOCALES) {
      const catalog = loginMessages[locale];
      expect(catalog.orgDetected, `locale=${locale}`).toContain("{email}");
      expect(catalog.orgDetected, `locale=${locale}`).toContain("{org}");
      expect(catalog.ssoOrgDetected, `locale=${locale}`).toContain("{org}");
      expect(catalog.endpointGateSubtitle, `locale=${locale}`).toContain(
        "{reason}",
      );
    }
  });

  it("手机号 placeholder 与固定 +86 前缀语义一致,不再提示输入国码", () => {
    expect(loginMessages["zh-CN"].phonePlaceholder).toBe("输入手机号");
    expect(loginMessages.en.phonePlaceholder).toBe("Phone number");
  });

  it("区域确认正文按标准 26/40 固定两行，中英每行均无需二次折行", () => {
    const maxEstimatedUnits =
      (LOGIN_CONSENT_DIALOG.body.width * 0.95 * 3) /
      LOGIN_CONSENT_DIALOG.body.font;
    const estimatedUnits = (value: string) =>
      [...value].reduce(
        (sum, character) =>
          sum + ((character.codePointAt(0) ?? 0) <= 0xff ? 0.5 : 1),
        0,
      );
    for (const locale of LOCALES) {
      const messages = loginMessages[locale];
      for (const body of [
        messages.realmConsentBodyCn,
        messages.realmConsentBodyGlobal,
        messages.realmConsentPersonalBodyCn,
        messages.realmConsentPersonalBodyGlobal,
      ]) {
        const lines = body.split("\n");
        expect(lines, `locale=${locale}: ${body}`).toHaveLength(2);
        for (const line of lines) {
          expect(
            estimatedUnits(line),
            `locale=${locale}: ${line}`,
          ).toBeLessThanOrEqual(maxEstimatedUnits / 3);
        }
      }
    }
  });

  it("登录错误码中英齐全且非空", () => {
    const codes = Object.keys(authErrorMessages);
    expect(codes.length).toBeGreaterThan(0);
    for (const code of codes) {
      const perLocale = authErrorMessages[code];
      expect(Object.keys(perLocale).sort(), `code=${code}`).toEqual(
        [...LOCALES].sort(),
      );
      for (const locale of LOCALES) {
        expect(
          perLocale[locale].trim(),
          `code=${code} locale=${locale} 不得为空`,
        ).not.toBe("");
      }
    }
  });
});

describe("resolveLoginLocale 系统 locale 解析", () => {
  it("所有中文标签 → zh-CN", () => {
    for (const tag of [
      "zh-Hant",
      "zh-Hant-TW",
      "zh-Hant-HK",
      "zh-TW",
      "zh-HK",
      "zh-MO",
      "ZH-HANT-TW",
      "ZH-HANT-TW",
    ]) {
      expect(resolveLoginLocale(tag), tag).toBe("zh-CN");
    }
  });

  it("简体脚本与中国大陆/新加坡/裸 zh → zh-CN", () => {
    for (const tag of [
      "zh",
      "zh-CN",
      "zh-Hans",
      "zh-Hans-CN",
      "zh-SG",
      "zh-Hans-HK",
      "zh-Hans-MO",
    ]) {
      expect(resolveLoginLocale(tag), tag).toBe("zh-CN");
    }
  });

  it("en 前缀映射到英文", () => {
    expect(resolveLoginLocale("en")).toBe("en");
    expect(resolveLoginLocale("en-US")).toBe("en");
  });

  it("其余与缺失 → 兜底 zh-CN", () => {
    for (const tag of ["ja-JP", "ko-KR", "fr-FR", "de", "", undefined, null]) {
      expect(resolveLoginLocale(tag), String(tag)).toBe("zh-CN");
    }
  });
});

describe("loginText / authErrorText 按显示语言取文案", () => {
  afterEach(() => {
    setManualLocaleOverride(null);
  });

  it("未设置偏好时取默认中文", () => {
    expect(loginText("title")).toBe(loginMessages["zh-CN"].title);
  });

  it("getAuthLocale 只输出 zh-CN | en", () => {
    const expectations: Array<[LoginLocale, "zh-CN" | "en"]> = [
      ["zh-CN", "zh-CN"],
      ["en", "en"],
    ];
    for (const [locale, expected] of expectations) {
      setManualLocaleOverride(locale);
      expect(getAuthLocale(), locale).toBe(expected);
    }
  });

  it("未知错误码回退 errorFallback,null 返回 null", () => {
    setManualLocaleOverride("en");
    expect(authErrorText("SOME_UNKNOWN_CODE")).toBe(
      loginMessages.en.errorFallback,
    );
    expect(authErrorText(null)).toBeNull();
  });
});
