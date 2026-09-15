#!/usr/bin/env node
/**
 * dev-remote-env.mjs — dev:remote / dev:inspect 的构建身份注入包装。
 *
 * 2026-07 端点清单重构后,运行期业务端点全部来自启动时解析的端点清单
 * (restart 按 --region 读仓内 config/endpoint*.json,--endpoints-cdn 走对应区域
 * 线上 CDN),本包装
 * 不再注入任何端点 URL;剩余职责是「remote 模式不读 apps/desktop/.env」的
 * 构建身份注入只剩 VITE_CINDY_AUTH_REGION(强制覆盖,不吃 .env 同名变量)。
 *
 * 用法:node scripts/dev-remote-env.mjs <command> [args...]
 */
import { spawn } from 'node:child_process';
import path from 'node:path';

import {
  applyDesktopDevStartupConfig,
  stripDesktopDevRegionArgs,
} from '../../../scripts/shared/desktop-dev-region.mjs';

// 启动链扁平化（2026-09-13）：绕过 pnpm run 直调时，node_modules/.bin 不在 PATH，
// 这里显式注入（electron-forge 等命令依赖它解析）。cwd 应为 apps/desktop。
process.env.PATH = `${path.join(process.cwd(), 'node_modules', '.bin')}${path.delimiter}${process.env.PATH ?? ''}`;

// 启动提速（2026-09-13）：本进程自提升为 AboveNormal 优先级——整个进程树（forge/
// vite/rolldown/Electron）继承，构建与启动在 CPU 竞争（游戏/IDE 等同时运行时）中
// 优先调度。失败静默（非 Windows / 权限问题不影响正常启动）。
try {
  require('node:child_process').execSync(
    `powershell -NoProfile -Command "(Get-Process -Id ${process.pid}).PriorityClass = 'AboveNormal'"`,
    { stdio: 'ignore', timeout: 10_000 },
  );
} catch {
  /* 优先级提升失败不影响启动 */
}

const [command, ...rawArgs] = process.argv.slice(2);
if (!command) {
  console.error('usage: node scripts/dev-remote-env.mjs <command> [args...]');
  process.exit(2);
}

const startupConfig = applyDesktopDevStartupConfig({ argv: rawArgs, mode: 'remote' });
const args = stripDesktopDevRegionArgs(rawArgs);
// Dev 启动提速（2026-09-13）：Electron main 进程的 V8 编译缓存（Node 22.8+ 特性）——
// 35MB main bundle 的解析/求值二次启动大幅提速。默认注入；已有值不覆盖。
process.env.NODE_COMPILE_CACHE ??= 'E:\\AI\\cindy-harness\\.workbuddy\\tmp\\node-compile-cache';
// Dev 启动提速（2026-09-14）：构建目标切换到项目 rolldown-vite 后，rolldown 默认拆
// chunk + 动态 import 会产出多 chunk 产物，plugin-vite / Electron 期望单文件 CJS
// 入口（多 chunk 实测挂启动早期）。dev 下默认强制单文件 inlineDynamicImports；
// 已有值不覆盖；仅影响 dev 启动链，打包路径不受本脚本影响。
process.env.XDT_MAIN_INLINE_SINGLE ??= '1';
const env = {
  ...process.env,
  XDT_DESKTOP_DEV_MODE: 'remote',
  VITE_CINDY_AUTH_REGION: startupConfig.region,
};
const isWindows = process.platform === 'win32';

// Dev 启动分段探针（2026-09-12）：forge spawn 时刻，与 vite [boot-timing] 打点、
// 主进程 "App started" 行对齐，分解 anchor→App started 前置段。
console.log(`[boot-timing] dev-remote-env spawn ${command} @ ${new Date().toISOString()}`);

// Windows 下 electron-forge 等 .cmd shim 需要经 shell 解析;shell 模式下 Node 不转义
// args 数组(DEP0190),这里自行做最小引号处理(实际参数均为简单 token,含空格时兜底)。
const quote = (a) => (/[\s"]/.test(a) ? `"${a.replace(/"/g, '""')}"` : a);
// 启动提速（2026-09-15）：默认 start 改走 forge-start-direct 直启入口，绕过
// CLI 的 "Checking your system"（pnpm --version 子进程等，~1.5-2.5s）。
// 仅命令形态为 `electron-forge start ...` 时重定向；inspect 等变体仍走原 CLI。
let spawnCommand = command;
let spawnArgs = args;
if (command === 'electron-forge' && args[0] === 'start') {
  spawnCommand = process.execPath;
  spawnArgs = [path.join('scripts', 'forge-start-direct.mjs'), ...args.slice(1)];
  console.log('[boot-timing] forge-start-direct bypass CLI system check');
}
const child = isWindows
  ? spawn([spawnCommand, ...spawnArgs].map(quote).join(' '), { stdio: 'inherit', env, shell: true })
  : spawn(spawnCommand, spawnArgs, { stdio: 'inherit', env });

child.on('exit', (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 1);
});
child.on('error', (err) => {
  console.error(`[dev-remote-env] failed to launch ${command}: ${err.message}`);
  process.exit(1);
});
