import { describe, expect, it } from "vitest";

import { resolveSystemLocale } from "../locale";

describe("mobile locale resolution", () => {
  it("将所有中文变体统一归入 zh-CN", () => {
    expect(resolveSystemLocale("zh-Hans-HK")).toBe("zh-CN");
    expect(resolveSystemLocale("zh-Hant-CN")).toBe("zh-CN");
    expect(resolveSystemLocale("zh-CN")).toBe("zh-CN");
    expect(resolveSystemLocale("zh-SG")).toBe("zh-CN");
    expect(resolveSystemLocale("zh-TW")).toBe("zh-CN");
    expect(resolveSystemLocale("zh-HK")).toBe("zh-CN");
    expect(resolveSystemLocale("zh-Hant")).toBe("zh-CN");
  });

  it("英文命中 en,其它语言回退中文", () => {
    expect(resolveSystemLocale("en-US")).toBe("en");
    expect(resolveSystemLocale("fr-FR")).toBe("zh-CN");
    expect(resolveSystemLocale(null)).toBe("zh-CN");
  });
});
