import { describe, expect, it, vi } from 'vitest';

import {
  applyWindowsTaskbarIdentity,
  type WindowsTaskbarIdentityWindow,
} from '../windowsTaskbarIdentity';

describe('applyWindowsTaskbarIdentity', () => {
  it('Windows 下把 AUMID、ICO 路径和索引写入任务栏按钮', () => {
    const setAppDetails = vi.fn();
    const window: WindowsTaskbarIdentityWindow = { setAppDetails };

    expect(
      applyWindowsTaskbarIdentity(window, {
        platform: 'win32',
        appId: 'com.xd.cindy',
        appIconPath: String.raw`C:\Cindy\resources\icon.ico`,
      }),
    ).toBe(true);
    expect(setAppDetails).toHaveBeenCalledWith({
      appId: 'com.xd.cindy',
      appIconPath: String.raw`C:\Cindy\resources\icon.ico`,
      appIconIndex: 0,
    });
  });

  it('非 Windows 不调用平台专属 API', () => {
    const setAppDetails = vi.fn();
    const window: WindowsTaskbarIdentityWindow = { setAppDetails };

    expect(
      applyWindowsTaskbarIdentity(window, {
        platform: 'darwin',
        appId: 'com.xd.cindy',
        appIconPath: '/Applications/Cindy.app/Contents/Resources/icon.icns',
      }),
    ).toBe(false);
    expect(setAppDetails).not.toHaveBeenCalled();
  });

  it('Windows API 抛错时降级为启动不受阻断', () => {
    const window: WindowsTaskbarIdentityWindow = {
      setAppDetails: () => {
        throw new Error('unsupported');
      },
    };

    expect(
      applyWindowsTaskbarIdentity(window, {
        platform: 'win32',
        appId: 'com.xd.cindy',
        appIconPath: String.raw`C:\Cindy\resources\icon.ico`,
      }),
    ).toBe(false);
  });
});
