#!/usr/bin/env node
/**
 * start-desktop-dev.mjs — 开发版「启动/复用」薄壳。
 *
 * 目标:start-dev-cmd.cmd 不再嵌套 restart:desktop:remote,避免两条启动器链
 * 互相杀进程、外层 wait-ready 误报 DEV_PROCESS_EXITED。
 * 逻辑:目标沙箱已有匹配 checkout 的 ready dev 实例就复用;否则委托官方
 * restart 启动链(restart-desktop-remote.mjs --wait-ready -- --isolated=dev
 * --isolated-auth),沙箱/授权/等待全部复用官方实现。
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { collectDesktopWhoamiReport } from './desktop-whoami.mjs';
import {
  buildDesktopDevVerdictFromWhoami,
  printDesktopDevVerdict,
} from './desktop-dev-verdict.mjs';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const startupLogPath = path.join(rootDir, '.codex', 'log', 'desktop-dev-startup-timing.log');

/** 记录启动阶段耗时，便于定位真实瓶颈且不影响启动流程。 */
function recordStartupTiming(event, startedAt, detail = '') {
  try {
    fs.mkdirSync(path.dirname(startupLogPath), { recursive: true });
    fs.appendFileSync(startupLogPath, `${new Date().toISOString()} event=${event} elapsed_ms=${Date.now() - startedAt}${detail ? ` ${detail}` : ''}\n`);
  } catch {
    // 诊断日志不可用时不能阻断开发版启动。
  }
}

/** 计算隔离沙箱 userData 目录(与 restart 脚本的默认派生一致)。 */
export function defaultIsolatedUserDataDir(isolationName = 'dev', region = 'global') {
  const baseName = {
    cn: 'Cindy',
    global: 'CindyGlobal',
    dev: 'CindyDev',
  }[region] ?? 'CindyGlobal';
  const suffix = isolationName ? `-${isolationName}` : '';
  const dirName = `${baseName}-dev2${suffix}`;
  if (process.platform === 'win32') {
    const appData = process.env.APPDATA || path.join(process.env.USERPROFILE || '', 'AppData', 'Roaming');
    return path.join(appData, dirName);
  }
  if (process.platform === 'darwin') {
    return path.join(process.env.HOME || '', 'Library', 'Application Support', dirName);
  }
  const xdgConfig = process.env.XDG_CONFIG_HOME || path.join(process.env.HOME || '', '.config');
  return path.join(xdgConfig, dirName);
}

/** 检查目标沙箱里是否已有匹配 checkout/commit 的 ready dev 实例。 */
export function existingReadyInstance(report = null) {
  const actual = report ?? collectDesktopWhoamiReport({
    rootDir,
    userDataDir: defaultIsolatedUserDataDir('dev', process.env.CINDY_AUTH_REGION?.trim() || 'global'),
  });
  if (!actual.match) return null;
  return actual.instances.find((instance) => (
    instance.ready === true
    && instance.commitVerified === true
    && instance.commit === actual.expected.commit
  )) ?? null;
}

/** 委托官方 restart 启动链,等待窗口/auth/database ready。 */
/** 启动官方链；clean 模式会强制清理 Vite 产物，作为快速路径的回退。 */
function launchOfficialRestart({ clean = false } = {}) {
  const restartScript = path.join(rootDir, 'scripts', 'restart-desktop-remote.mjs');
  const args = [
    restartScript,
    '--wait-ready',
    '--',
    '--isolated=dev',
    '--isolated-auth',
  ];
  // 快速参数必须位于脚本路径之后，否则 Node 会把它误认为自身参数。
  if (!clean) args.splice(1, 0, '--fast-switch');
  const startedAt = Date.now();
  const result = spawnSync(process.execPath, args, {
    cwd: rootDir,
    env: process.env,
    stdio: 'inherit',
  });
  recordStartupTiming(clean ? 'full_restart' : 'fast_restart', startedAt, `exit=${result.status ?? 1}`);
  return result.status ?? 1;
}

function main() {
  const forceClean = process.argv.includes('--clean');
  const startedAt = Date.now();
  console.log(`==> Desktop dev startup mode: ${forceClean ? 'clean' : 'fast'} (timing log: ${startupLogPath})`);
  const existing = existingReadyInstance();
  if (!forceClean && existing) {
    printDesktopDevVerdict(buildDesktopDevVerdictFromWhoami({
      match: true,
      expected: { rootDir, commit: existing.commit },
      instances: [existing],
    }));
    console.log(`==> Desktop dev already ready, pid=${existing.pid}; reuse without restart.`);
    recordStartupTiming('reuse', startedAt, `pid=${existing.pid}`);
    return;
  }

  let code = launchOfficialRestart({ clean: forceClean });
  // 快速路径失败时只自动完整重建一次，避免缓存损坏导致用户手工反复试错。
  if (code !== 0 && !forceClean) {
    recordStartupTiming('fast_restart_failed', startedAt, `exit=${code}`);
    console.error('==> Fast desktop startup failed; retrying once with a clean Vite build...');
    code = launchOfficialRestart({ clean: true });
  }
  recordStartupTiming('startup_complete', startedAt, `exit=${code}`);
  if (code !== 0) {
    console.error(`start-desktop-dev: official restart exited with ${code}`);
    process.exitCode = code;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
