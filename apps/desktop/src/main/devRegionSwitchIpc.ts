/**
 * 开发版区域切换 IPC：点击后交给仓库重启编排器，以 Global 区域重新启动整套 Desktop。
 * 正式包不注册此通道，避免把构建期身份伪装成运行期开关。
 */

import { spawn, spawnSync } from 'node:child_process';
import { appendFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { app, BrowserWindow, dialog, ipcMain } from 'electron';

import { CURRENT_CINDY_REGION } from '../shared/brandRegion.js';
import { assertTrustedAppRendererEvent } from './security/trustedAppRenderer.js';

export const DEV_SWITCH_REGION_CHANNEL = 'dev:switch-region';
export const CURRENT_REGION_SYNC_CHANNEL = 'cindy:get-current-region';
export const EXPLICIT_REGION_SYNC_CHANNEL = 'cindy:has-explicit-region';
export const SELECT_REGION_CHANNEL = 'cindy:select-region';
let selectedRuntimeRegion: 'cn' | 'global' | null = null;

/** 返回当前进程内用户选择的区域，供登录页重新加载后读取。 */
export function getSelectedRuntimeRegion(): 'cn' | 'global' | null {
  return selectedRuntimeRegion;
}

/** 更新当前进程内的登录区域，不触发程序重启。 */
export function setSelectedRuntimeRegion(region: 'cn' | 'global'): void {
  selectedRuntimeRegion = region;
}

/** 退出登录后清除本次进程内的区域选择，让下一次登录重新选择版本。 */
export function clearSelectedRuntimeRegion(): void {
  selectedRuntimeRegion = null;
}

/** 延迟启动同一个正式包，等待当前实例释放 Windows 单实例锁。 */
function relaunchPackagedSelf(targetRegion: 'cn' | 'global'): void {
  const quotePowerShell = (value: string): string => "'" + value.replaceAll("'", "''") + "'";
  const command = 'Start-Sleep -Milliseconds 900; Start-Process -FilePath ' +
    quotePowerShell(process.execPath) + ' -ArgumentList ' +
    quotePowerShell('--cindy-region=' + targetRegion) + ' -WindowStyle Hidden';
  const launcher = spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', command], {
    detached: true, stdio: 'ignore', windowsHide: true,
  });
  launcher.unref();
}

/** 读取单程序本次启动选择的区域参数，缺省沿用构建区域。 */
function readRuntimeRegion(): 'cn' | 'global' {
  const value = process.argv.find((argument) => argument.startsWith('--cindy-region='))?.split('=', 2)[1];
  return value === 'cn' || value === 'global' ? value : CURRENT_CINDY_REGION === 'cn' ? 'cn' : 'global';
}

/** 从 Forge / Vite 可能返回的 appPath 向上定位包含重启器的仓库根目录。 */
function findRepositoryRoot(startPath: string): string | null {
  let current = path.resolve(startPath);
  for (;;) {
    const candidate = path.join(current, 'scripts', 'desktop-restart-runner.mjs');
    try {
      if (existsSync(candidate)) return current;
    } catch {
      return null;
    }
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

/** 解析正式包对应区域的另一个已安装程序路径。 */
function findPackagedTargetExecutable(targetRegion: 'cn' | 'global'): string | null {
  const configured = process.env[targetRegion === 'cn' ? 'CINDY_CN_EXE_PATH' : 'CINDY_GLOBAL_EXE_PATH'];
  const executableName = 'Cindy.exe';
  const installDir = path.dirname(app.getPath('exe'));
  const appData = app.getPath('appData');
  // 正式测试包按 out/<region>/Cindy.exe 并列存放，优先切换到对应兄弟目录。
  const outDir = path.dirname(installDir);
  const siblingTarget = path.join(outDir, targetRegion, executableName);
  const candidates = [
    configured,
    siblingTarget,
   path.join(installDir, '..', targetRegion === 'global' ? 'CindyGlobal' : 'Cindy', executableName),
    path.join(installDir, '..', targetRegion, executableName),
    path.join(installDir, '..', targetRegion === 'global' ? 'global' : 'cn', executableName),
    path.join(appData, 'Programs', targetRegion === 'global' ? 'CindyGlobal' : 'Cindy', executableName),
  ].filter((value): value is string => Boolean(value));
  return candidates.find((candidate) => existsSync(candidate)) ?? null;
}

/** 记录版本切换启动链，便于确认隐藏启动器是否真的脱离当前 Electron。 */
function writeSwitchDiagnostic(repositoryRoot: string, message: string): void {
  try {
    const logPath = path.join(repositoryRoot, '.codex', 'log', 'desktop-region-switch-runtime.log');
    appendFileSync(logPath, `[${new Date().toISOString()}] ${message}\n`, 'utf8');
  } catch {
    // 诊断日志失败不能阻断版本切换。
  }
}

/** 用独立 PowerShell 进程启动重启器，避免当前 dev 进程退出时连带清理子进程。 */
function launchDetachedRestartRunner(repositoryRoot: string, restartRunner: string, targetRegion: 'cn' | 'global'): void {
  const quotePowerShell = (value: string): string => "'" + value.replaceAll("'", "''") + "'";
  const logPath = path.join(repositoryRoot, '.codex', 'log', 'desktop-region-switch-runner.log');
  const command = [
    '$env:CINDY_AUTH_REGION = ' + quotePowerShell(targetRegion) + '; $env:VITE_CINDY_AUTH_REGION = ' + quotePowerShell(targetRegion) + '; $env:XDT_USER_DATA_DIR = $null; $env:XDT_USER_DATA_DIR_EPOCH = $null; $env:XDT_DEVICE_ID_OVERRIDE = $null; $env:XDT_ENDPOINT_MANIFEST_FILE = $null; $env:XDT_DESKTOP_DEV_STARTUP_STATUS_FILE = $null; $env:XDT_DESKTOP_DEV_RELAUNCH_SIGNAL_FILE = $null;',
    'Start-Process', '-FilePath', quotePowerShell('node.exe'), '-ArgumentList',
    '@(' + quotePowerShell(restartRunner) + ", '--wait-ready', '--fast-switch', '--region=" + targetRegion + "')",
    '-WorkingDirectory', quotePowerShell(repositoryRoot),
    '-RedirectStandardOutput', quotePowerShell(logPath), '-RedirectStandardError', quotePowerShell(logPath + '.err'),
    '-WindowStyle Hidden',
  ].join(' ');
  writeSwitchDiagnostic(repositoryRoot, 'launch target=' + targetRegion + ' root=' + repositoryRoot + ' runner=' + restartRunner);
  const result = spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', command], {
    cwd: repositoryRoot,
    stdio: 'ignore',
    windowsHide: true,
  });
  if (result.error || result.status !== 0) throw new Error('无法启动版本切换重启器：' + (result.error?.message ?? ('PowerShell exit ' + (result.status ?? 1))));
  writeSwitchDiagnostic(repositoryRoot, 'independent launcher accepted by PowerShell');
}

/** 注册开发版「切换区域并重启」入口。 */
export function registerDevRegionSwitchIpc(): void {
  ipcMain.removeAllListeners(CURRENT_REGION_SYNC_CHANNEL);
  ipcMain.on(CURRENT_REGION_SYNC_CHANNEL, (event) => {
    event.returnValue = selectedRuntimeRegion ?? readRuntimeRegion();
  });
  ipcMain.removeAllListeners(EXPLICIT_REGION_SYNC_CHANNEL);
  ipcMain.on(EXPLICIT_REGION_SYNC_CHANNEL, (event) => {
    event.returnValue = selectedRuntimeRegion !== null || process.argv.some((argument) => argument.startsWith('--cindy-region='));
  });
  if (app.isPackaged) {
    ipcMain.removeHandler(DEV_SWITCH_REGION_CHANNEL);
    ipcMain.handle(DEV_SWITCH_REGION_CHANNEL, async (event, targetRegion: unknown) => {
      assertTrustedAppRendererEvent(event);
      if (targetRegion !== 'cn' && targetRegion !== 'global') throw new Error('目标区域必须是 cn 或 global');
      if (CURRENT_CINDY_REGION === targetRegion) throw new Error('当前已经是目标区域构建');
      const confirmation = await dialog.showMessageBox({
        type: 'question', title: '切换版本',
        message: targetRegion === 'global' ? '确认切换国际版并重启？' : '确认切换中国版并重启？',
        buttons: ['确认并重启', '取消'], defaultId: 0, cancelId: 1, noLink: true,
      });
      if (confirmation.response !== 0) return { ok: false, canceled: true } as const;
      // 单程序正式包：区域只是启动参数，不再寻找或安装第二份 Cindy.exe。
      const targetExecutable = process.execPath;
      const child = spawn(targetExecutable, [`--cindy-region=${targetRegion}`], {
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
        env: { ...process.env, CINDY_AUTH_REGION: targetRegion, VITE_CINDY_AUTH_REGION: targetRegion },
      });
      child.once('error', (error) => writeSwitchDiagnostic(path.dirname(targetExecutable), 'packaged launch failed: ' + error.message));
      child.unref();
      app.quit();
      return { ok: true } as const;
    });
    return;
  }

  ipcMain.removeHandler(DEV_SWITCH_REGION_CHANNEL);
  ipcMain.handle(DEV_SWITCH_REGION_CHANNEL, async (event, targetRegion: unknown) => {
    assertTrustedAppRendererEvent(event);
    if (targetRegion !== 'cn' && targetRegion !== 'global') {
      throw new Error('目标区域必须是 cn 或 global');
    }
    if (CURRENT_CINDY_REGION === targetRegion) {
      throw new Error('当前已经是目标区域构建');
    }

    const ownerWindow = BrowserWindow.fromWebContents(event.sender);
    const confirmation = ownerWindow && !ownerWindow.isDestroyed()
      ? await dialog.showMessageBox(ownerWindow, {
          type: 'question',
          title: '切换版本',
          message: targetRegion === 'global' ? '确认切换国际版并重启？' : '确认切换中国版并重启？',
          buttons: ['确认并重启', '取消'],
          defaultId: 0,
          cancelId: 1,
          noLink: true,
        })
      : await dialog.showMessageBox({
          type: 'question',
          title: '切换版本',
          message: targetRegion === 'global' ? '确认切换国际版并重启？' : '确认切换中国版并重启？',
          buttons: ['确认并重启', '取消'],
          defaultId: 0,
          cancelId: 1,
          noLink: true,
        });
    if (confirmation.response !== 0) return { ok: false, canceled: true } as const;

    const repositoryRoot = findRepositoryRoot(app.getAppPath());
    if (!repositoryRoot) {
      throw new Error('找不到桌面端仓库根目录，无法启动版本切换');
    }
    const restartRunner = path.join(repositoryRoot, 'scripts', 'desktop-restart-runner.mjs');
    launchDetachedRestartRunner(repositoryRoot, restartRunner, targetRegion);
    // PowerShell 已成功交给系统调度后，当前实例可以退出并释放开发锁。
    app.quit();
    return { ok: true } as const;
  });
}
