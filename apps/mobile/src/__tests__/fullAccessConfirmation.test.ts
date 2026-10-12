import { describe, expect, it, vi } from "vitest";

vi.mock("react-native", () => ({ Alert: { alert: vi.fn() } }));

import {
  confirmFullAccessChange,
  getFullAccessConfirmationCopy,
} from "@/session/fullAccessConfirmation";

function confirmingAlert() {
  return vi.fn((_title, _message, buttons) => {
    buttons?.[1]?.onPress?.();
  });
}

describe("getFullAccessConfirmationCopy", () => {
  it("selects the supported system language and falls back to Chinese", () => {
    expect(getFullAccessConfirmationCopy("en").confirm).toBe(
      "Enable Full access",
    );
    expect(getFullAccessConfirmationCopy("zh-Hans-CN").title).toBe(
      "开启 Full access？",
    );
    // 繁体中文不再作为独立语言,统一回退简体中文。
    expect(getFullAccessConfirmationCopy("zh-Hant-TW").title).toBe(
      "开启 Full access？",
    );
    expect(getFullAccessConfirmationCopy("fr").title).toBe(
      "开启 Full access？",
    );
    expect(getFullAccessConfirmationCopy("ja").title).toBe("开启 Full access？");
    expect(getFullAccessConfirmationCopy("ko-KR").cancel).toBe("保留当前权限");
  });
});

describe("confirmFullAccessChange", () => {
  it("does not show an alert when the change does not enter Full access", async () => {
    const showAlert = vi.fn();

    await expect(
      confirmFullAccessChange("auto", "ask", { showAlert }),
    ).resolves.toBe(true);
    expect(showAlert).not.toHaveBeenCalled();
  });

  it("restores a remembered Full access default without showing an alert", async () => {
    const showAlert = vi.fn();

    await expect(
      confirmFullAccessChange("ask", "bypassPermissions", {
        restoringRememberedChoice: true,
        showAlert,
      }),
    ).resolves.toBe(true);
    expect(showAlert).not.toHaveBeenCalled();
  });

  it("asks on every explicit transition into Full access", async () => {
    const showAlert = confirmingAlert();

    await expect(
      confirmFullAccessChange("ask", "bypassPermissions", { showAlert }),
    ).resolves.toBe(true);
    await expect(
      confirmFullAccessChange("auto", "bypassPermissions", { showAlert }),
    ).resolves.toBe(true);
    expect(showAlert).toHaveBeenCalledTimes(2);
  });

  it("keeps the previous mode when the user cancels", async () => {
    const showAlert = vi.fn((_title, _message, buttons) => {
      buttons?.[0]?.onPress?.();
    });

    await expect(
      confirmFullAccessChange("auto", "bypassPermissions", { showAlert }),
    ).resolves.toBe(false);
    expect(showAlert).toHaveBeenCalledOnce();
    expect(showAlert.mock.calls[0]?.[2]?.[1]).toMatchObject({
      style: "destructive",
    });
  });

  it("treats dismiss as cancellation", async () => {
    const showAlert = vi.fn((_title, _message, _buttons, options) => {
      options?.onDismiss?.();
    });

    await expect(
      confirmFullAccessChange(undefined, "bypassPermissions", { showAlert }),
    ).resolves.toBe(false);
  });
});
