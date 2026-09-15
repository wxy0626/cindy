#!/usr/bin/env node
/**
 * forge-start-direct.mjs — 绕过 electron-forge CLI 的直启入口（启动优化 2026-09-15）。
 *
 * CLI 的 preSubcommand 会无条件执行 "Checking your system"（含 pnpm --version
 * 子进程）+ commander 解析，实测 ~1.5-2.5s。本脚本等价复刻 CLI start 命令的
 * 核心行为（见 node_modules/@electron-forge/cli/dist/electron-forge-start.js）：
 * 拆分 "--" 前后的参数，直接调用 @electron-forge/core 的 api.start 并托管
 * Electron 子进程的 exit/restarted 事件。仅 dev 启动链使用，打包路径不受影响。
 *
 * 用法：node scripts/forge-start-direct.mjs [forge参数...] -- [app参数...]
 * 当前 dev 链只使用默认 start（无 --inspect-electron 等 forge 侧参数），
 * 出现未支持的 forge 参数时回退提示走原 CLI。
 */
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { api } = require('@electron-forge/core');
const path = require('node:path');
const process = globalThis.process;

const argv = process.argv.slice(2);
const doubleDash = argv.indexOf('--');
const forgeArgs = doubleDash === -1 ? argv : argv.slice(0, doubleDash);
const appArgs = doubleDash === -1 ? [] : argv.slice(doubleDash + 1);

// 当前启动链只使用默认 start；遇到 forge 侧参数（--inspect-electron 等）时
// 保守回退到原 CLI，避免行为分叉。
if (forgeArgs.length > 0) {
  console.error(
    `[forge-start-direct] unsupported forge args: ${forgeArgs.join(' ')} — falling back to electron-forge CLI`,
  );
  const { spawnSync } = await import('node:child_process');
  const result = spawnSync('electron-forge', ['start', ...argv], {
    stdio: 'inherit',
    shell: process.platform === 'win32',
    cwd: path.resolve(import.meta.dirname ?? '.'),
  });
  process.exit(result.status ?? 1);
}

const opts = {
  // cwd 由 dev-remote-env 固定在 apps/desktop（Electron 应用目录）。
  dir: process.cwd(),
  interactive: process.stdin.isTTY ?? false,
  enableLogging: false,
  runAsNode: false,
  inspect: false,
  inspectBrk: false,
};
if (appArgs.length > 0) opts.args = appArgs;

const spawned = await api.start(opts);
await new Promise((resolve) => {
  const listenForExit = (child) => {
    let onExit;
    let onRestart;
    const removeListeners = () => {
      child.removeListener('exit', onExit);
      child.removeListener('restarted', onRestart);
    };
    onExit = (code) => {
      removeListeners();
      if (spawned.restarted) return;
      if (code !== 0) process.exit(code);
      resolve();
    };
    onRestart = (newChild) => {
      removeListeners();
      listenForExit(newChild);
    };
    child.on('exit', onExit);
    child.on('restarted', onRestart);
  };
  listenForExit(spawned);
});
