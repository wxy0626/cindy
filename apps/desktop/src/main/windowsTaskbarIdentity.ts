/**
 * Windows 任务栏身份图标绑定。
 *
 * BrowserWindow 的 icon 只负责窗口图标；Windows 任务栏还会按 AppUserModelId
 * 查找应用身份图标。开发版没有打包 EXE 资源时，如果不调用 setAppDetails，
 * 任务栏可能退回白色通用文件图标。
 */

export interface WindowsTaskbarIdentityWindow {
  /** Electron 在 Windows 上把任务栏按钮绑定到应用身份和图标。 */
  setAppDetails(options: { appId: string; appIconPath: string; appIconIndex?: number }): void;
}

export interface WindowsTaskbarIdentityOptions {
  /** 当前运行平台，用于保证非 Windows 不触碰平台专属 API。 */
  platform: NodeJS.Platform;
  /** 与 app.setAppUserModelId / NSIS appId 保持一致的应用身份。 */
  appId: string;
  /** Windows 图标文件的绝对路径。 */
  appIconPath: string;
}

/** 为 Windows 任务栏按钮显式写入 AUMID 与 ICO 图标，成功返回 true。 */
export function applyWindowsTaskbarIdentity(
  window: WindowsTaskbarIdentityWindow,
  options: WindowsTaskbarIdentityOptions,
): boolean {
  if (options.platform !== 'win32') return false;

  try {
    window.setAppDetails({
      appId: options.appId,
      appIconPath: options.appIconPath,
      appIconIndex: 0,
    });
    return true;
  } catch {
    // 任务栏身份是增强项；即使旧版 Electron / 受限 Windows 环境拒绝，也不阻断启动。
    return false;
  }
}
