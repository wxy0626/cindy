#!/usr/bin/env node
import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
// 最终启动耗时用绿色加粗高亮（启动优化 2026-09-15）：chalk 会自动处理 Windows
// 控制台的 VT 序列启用，避免耗时数字淹没在普通日志里。
import chalk from 'chalk';
import {
  applyDesktopDevStartupConfig,
  DESKTOP_DEV_REGIONS,
  desktopUserDataDirNameForRegion,
  resolveDesktopDevRegion,
} from './shared/desktop-dev-region.mjs';
import {
  buildDesktopDevVerdictFromFailure,
  buildDesktopDevVerdictFromWhoami,
  desktopRestartArgvConflictMessage,
  normalizeDesktopRestartArgv,
  printDesktopDevVerdict,
  resolveIsolatedArg,
  restartContextFromArgv,
  SHARED_USERDATA_ARG,
} from './desktop-dev-verdict.mjs';
import { collectDesktopWhoamiReport } from './desktop-whoami.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');
const gracefulTimeoutMs = 3000;
const forceTimeoutMs = 5000;
const pollIntervalMs = 150;
// 启动就绪超时:2026-09-11 起默认保留 vite 缓存(--clean 才清),暖启动全链路
// 通常 1 分钟上下;但 --clean / 首次启动 / vite 大版本升级后仍是冷启动全量预编译,
// 叠加 auth→localDb 初始化链可达 2-3 分钟(同日实证),120s 处于刀口上必然超时
// (2026-09-11 双击启动器 STARTUP_TIMEOUT 实证)。给 300s 留足余量;真正的失败
// (AUTH_INIT_FAILED 等写 failed 状态)仍会提前抛出,不会傻等满额。
const startupReadyTimeoutMs = 300_000;
export const ISOLATED_AUTH_LAUNCH_PROOF_FILE = '.isolated-auth-launch-proof.json';
const isolatedAuthLaunchProofTtlMs = 10 * 60_000;
const forceKillLabel = process.platform === 'win32' ? 'taskkill /F /T' : 'kill -9';
const desktopDevCacheRelativeDirs = Object.freeze([
  path.join('apps', 'desktop', 'node_modules', '.vite'),
  path.join('apps', 'desktop', '.vite'),
]);

/**
 * 产品默认 userData 目录基名。⚠️ 值必须与
 * packages/maker-shared/src/brandIdentity.ts 的 BRAND_IDENTITY.userDataDirName
 * 一致——.mjs 无法 import TS 单点,只能镜像字面量;
 * 一致性由 scripts/__tests__/brand-identity-sync.test.mjs 断言兜底。
 */
export const BRAND_USER_DATA_DIR_NAME = 'Cindy';

// 桌面端 .env 默认值。2026-07 端点清单重构后 .env 不再承载任何端点 URL
// (运行期端点全部来自清单:remote restart 按 region 读 config/endpoint*.json,
// local 模式读生成的 config/endpoint.local.json,--endpoints-cdn 走线上 CDN),这里只
// 保留 region 身份。飞书登录构建变量已退役,不再创建或补写。
function desktopEnvSpec() {
  return [{ key: 'VITE_CINDY_AUTH_REGION', value: 'global', force: false }];
}
const closeDarwinTerminalTtyScript = Object.freeze([
  'on closeMatchingTerminalTab(targetTty)',
  'tell application "Terminal"',
  'repeat with terminalWindow in windows',
  'repeat with terminalTab in tabs of terminalWindow',
  'if (tty of terminalTab) is targetTty then',
  'try',
  'if busy of terminalTab is false then do script "exit" in terminalTab',
  'end try',
  'delay 1',
  'try',
  'if not (exists terminalWindow) then return',
  'if not (exists terminalTab) then return',
  'if (count of tabs of terminalWindow) is 1 then',
  'close terminalWindow',
  'else',
  'close terminalTab',
  'end if',
  'end try',
  'return',
  'end if',
  'end repeat',
  'end repeat',
  'end tell',
  'end closeMatchingTerminalTab',
  'on run argv',
  'my closeMatchingTerminalTab(item 1 of argv)',
  'end run',
]);
const launchDarwinTerminalScript = Object.freeze([
  'on run argv',
  'set devCommand to item 1 of argv',
  'tell application "Terminal"',
  'set targetTab to do script devCommand',
  'set targetWindow to front window',
  'activate',
  'end tell',
  'repeat',
  'delay 1',
  'tell application "Terminal"',
  'if not (exists targetWindow) then return',
  'if not (exists targetTab) then return',
  'if busy of targetTab is false then',
  'try',
  'if (count of tabs of targetWindow) is 1 then',
  'close targetWindow',
  'else',
  'close targetTab',
  'end if',
  'end try',
  'return',
  'end if',
  'end tell',
  'end repeat',
  'end run',
]);

function normalize(value) {
  return value.replaceAll('\\', '/').toLowerCase();
}

function stripTrailingSlashes(value) {
  return value.replace(/\/+$/, '');
}

export function commandContainsPath(command, candidatePath) {
  const normalizedCommand = normalize(command);
  const normalizedPath = stripTrailingSlashes(normalize(candidatePath));
  if (!normalizedPath) return false;
  let index = normalizedCommand.indexOf(normalizedPath);
  while (index !== -1) {
    const before = normalizedCommand[index - 1];
    const after = normalizedCommand[index + normalizedPath.length];
    const hasStartBoundary = before === undefined || /\s|["'=]/.test(before);
    // 命令行无法安全区分「裸 root 后接参数」和「带空格的 sibling 路径」。
    // 空格当结束边界会误伤 sibling；不当结束会漏认裸路径。desktop-dev 命令行里
    // checkout 都以 /node_modules 或 /apps/desktop 出现，保守匹配足够。
    const hasEndBoundary = after === undefined || after === '/' || after === '"' || after === "'";
    if (hasStartBoundary && hasEndBoundary) return true;
    index = normalizedCommand.indexOf(normalizedPath, index + 1);
  }
  return false;
}

/**
 * 判断进程命令行是否带 `--user-data-dir=<userDataDir>`(Electron helper 进程携带)。
 * 结束边界必须是行尾 / 空白 / 引号 / 斜杠 —— `Cindy-dev` 不得命中
 * `Cindy-dev-pi-latest` 这类前缀同名沙箱。路径本身可含空格(macOS 的
 * "Application Support"),所以整段 needle 精确匹配、只对尾部做边界判定。
 */
export function commandUsesUserDataDir(command, userDataDir) {
  const normalizedCommand = normalize(command);
  const normalizedDir = stripTrailingSlashes(normalize(userDataDir));
  if (!normalizedDir) return false;
  // 值可能带引号(Windows 常见: --user-data-dir="C:\..."), 裸值与引号包裹
  // 两种形态都要命中, 否则冲突检测漏判会放行进共享 SQLite/登录态。
  const needles = [
    `--user-data-dir=${normalizedDir}`,
    `--user-data-dir="${normalizedDir}`,
    `--user-data-dir='${normalizedDir}`,
  ];
  for (const needle of needles) {
    let index = normalizedCommand.indexOf(needle);
    while (index !== -1) {
      const after = normalizedCommand[index + needle.length];
      if (after === undefined || after === '/' || after === '"' || after === "'" || /\s/.test(after)) {
        return true;
      }
      index = normalizedCommand.indexOf(needle, index + 1);
    }
  }
  return false;
}

/**
 * 重启的 kill 作用域:只收当前 checkout(ownRootDir)自己的 dev 进程。其他
 * worktree / 命名沙箱一律保留 ——「重启」的语义是重启这份 checkout 的实例,
 * 不是清场(2026-07-30 约束:PI 沙箱启动器曾全灭掉并行的 tgbot-review 沙箱)。
 */
export function partitionDesktopDevProcesses(processes, ownRootDir) {
  const targets = [];
  const preserved = [];
  for (const proc of processes) {
    (commandContainsPath(proc.command, ownRootDir) ? targets : preserved).push(proc);
  }
  return { targets, preserved };
}

function run(command, args, options = {}) {
  return spawnSync(command, args, {
    encoding: 'utf8',
    windowsHide: true,
    ...options,
  });
}

function ensureDesktopEnv() {
  const envPath = path.join(rootDir, 'apps', 'desktop', '.env');
  const examplePath = path.join(rootDir, 'apps', 'desktop', '.env.example');
  let content = '';
  let created = false;

  if (fs.existsSync(envPath)) {
    content = fs.readFileSync(envPath, 'utf8');
  } else {
    created = true;
    content = fs.existsSync(examplePath)
      ? fs.readFileSync(examplePath, 'utf8')
      : '';
  }

  for (const { key, value, force } of desktopEnvSpec(content)) {
    content = upsertEnvValue(content, key, value, { overwrite: created || force });
  }

  fs.mkdirSync(path.dirname(envPath), { recursive: true });
  fs.writeFileSync(envPath, content.endsWith('\n') ? content : `${content}\n`);

  if (created) {
    console.log(`==> Created desktop env: ${path.relative(rootDir, envPath)}`);
  } else {
    console.log(`==> Checked desktop env: ${path.relative(rootDir, envPath)}`);
  }
}

function readEnvValue(content, key) {
  const pattern = new RegExp(`^\\s*${escapeRegExp(key)}\\s*=\\s*(.*?)\\s*$`, 'm');
  return content.match(pattern)?.[1]?.trim() ?? '';
}

function upsertEnvValue(content, key, value, options = {}) {
  const lines = content.split(/\r?\n/);
  const pattern = new RegExp(`^\\s*${escapeRegExp(key)}\\s*=`);
  let found = false;

  const next = lines.map((line) => {
    if (!pattern.test(line)) return line;
    found = true;
    const current = line.slice(line.indexOf('=') + 1).trim();
    return current && !options.overwrite ? line : `${key}=${value}`;
  });

  if (!found) next.push(`${key}=${value}`);
  return next.join('\n');
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function desktopDevCacheDirs(root = rootDir) {
  return desktopDevCacheRelativeDirs.map((entry) => path.join(root, entry));
}

function assertDesktopDevCachePath(root, target) {
  const resolvedRoot = path.resolve(root);
  const resolvedTarget = path.resolve(target);
  const allowedTargets = new Set(desktopDevCacheDirs(resolvedRoot).map((entry) => path.resolve(entry)));
  if (!allowedTargets.has(resolvedTarget)) {
    throw new Error(`Refusing to remove unexpected desktop dev cache path: ${resolvedTarget}`);
  }
  const relative = path.relative(resolvedRoot, resolvedTarget);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`Refusing to remove desktop dev cache outside repository: ${resolvedTarget}`);
  }
}

export function clearDesktopDevCaches(root = rootDir, { logger = console } = {}) {
  const removed = [];
  for (const cacheDir of desktopDevCacheDirs(root)) {
    assertDesktopDevCachePath(root, cacheDir);
    if (!fs.existsSync(cacheDir)) continue;
    fs.rmSync(cacheDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    removed.push(cacheDir);
  }

  if (removed.length > 0) {
    logger.log(
      `==> Cleared desktop dev cache: ${removed.map((entry) => path.relative(root, entry)).join(', ')}`,
    );
  } else {
    logger.log('==> Desktop dev cache already clean.');
  }
  return removed;
}

function listWindowsProcesses() {
  const script = `
$ErrorActionPreference = 'SilentlyContinue'
Get-CimInstance Win32_Process |
  Where-Object { $_.CommandLine } |
  Select-Object ProcessId,ParentProcessId,CommandLine |
  ConvertTo-Json -Compress
`;
  const result = run('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script]);
  if (result.status !== 0 || !result.stdout.trim()) return [];
  try {
    const parsed = JSON.parse(result.stdout);
    return (Array.isArray(parsed) ? parsed : [parsed]).map((item) => ({
      pid: Number(item.ProcessId),
      ppid: Number(item.ParentProcessId) || 0,
      command: String(item.CommandLine ?? ''),
    }));
  } catch {
    return [];
  }
}

function listPosixProcesses() {
  const result = run('ps', ['-eo', 'pid=,ppid=,tty=,command=']);
  if (result.status !== 0) return [];
  return result.stdout
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const match = line.match(/^(\d+)\s+(\d+)\s+(\S+)\s+(.+)$/);
      if (!match) return null;
      return {
        pid: Number(match[1]),
        ppid: Number(match[2]) || 0,
        tty: match[3],
        command: match[4],
      };
    })
    .filter(Boolean);
}

export function parseWorktreePaths(text) {
  return text
    .split(/\r?\n/)
    .filter((line) => line.startsWith('worktree '))
    .map((line) => path.resolve(line.slice('worktree '.length)));
}

function repositoryWorktreePaths() {
  const result = run('git', ['worktree', 'list', '--porcelain'], { cwd: rootDir });
  if (result.status !== 0) return [rootDir];
  const worktrees = parseWorktreePaths(result.stdout);
  return worktrees.length > 0 ? worktrees : [rootDir];
}

function hasRepositoryCheckoutPath(command, checkoutPaths = repositoryWorktreePaths()) {
  return checkoutPaths.some((checkoutPath) => commandContainsPath(command, checkoutPath));
}

// 沿 ppid 链向上找祖先里有没有 Cindy desktop dev 进程。
// 用途：拦住"agent 跑在【当前 checkout】的 desktop dev 里还调 restart"这种自杀场景——
// kill 作用域虽已限本 checkout，但祖先就是这份 checkout 时仍会把本脚本一起收掉。
// 宿主是正式版或另一个 worktree 时不拦：杀不到那份祖先，隔离启动可以继续。
function findDevAncestor() {
  const processes = listAllProcessesOnce();
  const byPid = new Map(processes.map((proc) => [proc.pid, proc]));
  const checkoutPaths = repositoryWorktreePathsOnce();
  let cursor = byPid.get(process.pid)?.ppid ?? 0;
  for (let i = 0; cursor && i < 64; i += 1) {
    const ancestor = byPid.get(cursor);
    if (!ancestor) break;
    const command = normalize(ancestor.command);
    if (
      !command.includes('apps/claude-code-bin') &&
      !command.includes('apps/codex-bin') &&
      hasRepositoryCheckoutPath(command, checkoutPaths) &&
      hasDesktopDevSignature(command)
    ) {
      return ancestor;
    }
    cursor = ancestor.ppid;
  }
  return null;
}

function hasDesktopDevSignature(command) {
  return (
    command.includes('electron-forge') ||
    command.includes('@electron-forge') ||
    command.includes('dev:desktop') ||
    command.includes('pnpm --filter desktop dev') ||
    command.includes('/node_modules/electron/') ||
    (command.includes('/apps/desktop/') && (
      command.includes('vite.main.config') ||
      command.includes('vite.renderer.config') ||
      command.includes('vite.preload.config') ||
      command.includes('--app-path=')
    ))
  );
}

export function isRepositoryDesktopDevProcess(proc, checkoutPaths, currentPid = process.pid) {
  if (!proc.pid || proc.pid === currentPid) return false;
  const command = normalize(proc.command);
  if (command.includes('apps/claude-code-bin') || command.includes('apps/codex-bin')) return false;
  // Durable PI Subagent runners intentionally outlive the Electron main
  // process. They use the bundled Electron executable with
  // ELECTRON_RUN_AS_NODE=1, so the executable path alone looks like a Desktop
  // dev process. Killing them alongside the app turns a normal dev restart
  // into an unexpected terminal failure instead of letting the next Desktop
  // instance reattach to the still-running durable job.
  if (
    command.includes('/runtime/pi-subagent-runs/')
    && command.includes('/runner.cjs')
  ) return false;

  return hasRepositoryCheckoutPath(command, checkoutPaths) && hasDesktopDevSignature(command);
}

function killProcess(pid) {
  if (process.platform === 'win32') {
    return run('taskkill.exe', ['/F', '/T', '/PID', String(pid)]).status === 0;
  }

  try {
    process.kill(pid, 'SIGTERM');
  } catch {
    return false;
  }
  return true;
}

function forceKillProcess(pid) {
  if (process.platform === 'win32') {
    return killProcess(pid);
  }

  try {
    process.kill(pid, 'SIGKILL');
  } catch {
    return false;
  }
  return true;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function listDesktopDevProcesses() {
  const processes = process.platform === 'win32' ? listWindowsProcesses() : listPosixProcesses();
  const checkoutPaths = repositoryWorktreePaths();
  return processes.filter((proc) => isRepositoryDesktopDevProcess(proc, checkoutPaths));
}

// 启动提速:重启前置的三连扫(devAncestor 祖先链 / userData 冲突检测 / kill 目标
// 枚举)此前各自独立跑一遍 Get-CimInstance + git worktree list,每次 1-4s,纯浪费。
// 这些检查都发生在 kill 之前的同一窗口内,进程布局在此窗口内的变化毫无意义,
// 共用一份快照即可。waitForDesktopDevProcessesToExit 的轮询走 listDesktopDevProcesses()
// 实时枚举,不受此缓存影响(那里才是真正需要新数据的地方)。
let preStartFullProcessSnapshot = null;
let preStartWorktreePathsCache = null;

/** 启动前置检查专用的全量进程快照(仅 kill 之前的检查共享)。 */
function listAllProcessesOnce() {
  preStartFullProcessSnapshot ??=
    process.platform === 'win32' ? listWindowsProcesses() : listPosixProcesses();
  return preStartFullProcessSnapshot;
}

/** 启动前置检查专用的 worktree 路径快照(git worktree list 结果在运行期内稳定)。 */
function repositoryWorktreePathsOnce() {
  preStartWorktreePathsCache ??= repositoryWorktreePaths();
  return preStartWorktreePathsCache;
}

/** 与 listDesktopDevProcesses 相同的过滤,但消费启动期快照,不重新扫描系统。 */
function listDesktopDevProcessesOnce() {
  const checkoutPaths = repositoryWorktreePathsOnce();
  return listAllProcessesOnce().filter((proc) => isRepositoryDesktopDevProcess(proc, checkoutPaths));
}

async function waitForDesktopDevProcessesToExit(timeoutMs, filter = () => true) {
  const deadline = Date.now() + timeoutMs;
  let remaining = listDesktopDevProcesses().filter(filter);

  while (remaining.length > 0 && Date.now() < deadline) {
    await sleep(pollIntervalMs);
    remaining = listDesktopDevProcesses().filter(filter);
  }

  return remaining;
}

function hasInteractiveTty() {
  return Boolean(process.stdin.isTTY && process.stdout.isTTY);
}

function psSingleQuote(value) {
  return `'${value.replaceAll("'", "''")}'`;
}

function cmdDoubleQuote(value) {
  return `"${value.replaceAll('"', '""')}"`;
}

function shellSingleQuote(value) {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function osascriptCloseDarwinTerminalTtyArgs(ttyPath) {
  return closeDarwinTerminalTtyScript
    .flatMap((line) => ['-e', line])
    .concat(ttyPath);
}

export function osascriptLaunchDarwinTerminalArgs(command) {
  return launchDarwinTerminalScript
    .flatMap((line) => ['-e', line])
    .concat(command);
}

function darwinTtyPath(tty) {
  if (!tty || tty === '??' || tty === '?') return null;
  return tty.startsWith('/dev/') ? tty : `/dev/${tty}`;
}

function darwinTerminalTtysForProcesses(processes) {
  if (process.platform !== 'darwin') return [];
  return [...new Set(processes.map((proc) => darwinTtyPath(proc.tty)).filter(Boolean))];
}

function closeDarwinTerminalTtys(ttys) {
  if (process.platform !== 'darwin' || ttys.length === 0) return;

  for (const ttyPath of ttys) {
    const result = run('osascript', osascriptCloseDarwinTerminalTtyArgs(ttyPath));
    if (result.status !== 0 && result.stderr.trim()) {
      console.warn(`==> Failed to close Terminal tab for ${ttyPath}: ${result.stderr.trim()}`);
    }
  }
}

/**
 * --isolated 的默认独立 userData 目录:与当前区域正式目录平级、名字带 -dev2 后缀,
 * 稳定不随 checkout 变(多个 worktree 共享同一个 dev 沙箱,想再细分用命名沙箱
 * `--isolated=<名字>` 或自己设 XDT_USER_DATA_DIR 覆盖)。命名沙箱目录再追加
 * `-<名字>` 后缀,每个名字一条完全独立的沙箱。只在 dev 生效——主进程入口只在
 * 非 packaged 时应用该覆写。
 */
function userDataDirNamed(dirName) {
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

export function hasIsolationIntent(argv = [], env = process.env) {
  return argv.some((arg) => arg === '--isolated' || arg.startsWith('--isolated='))
    || env.XDT_ISOLATED === '1';
}

export function officialProductionUserDataDirs() {
  return DESKTOP_DEV_REGIONS.map((region) => productionUserDataDir(region));
}

/** 与 devCliFlags ISOLATION_NAME_RE 一致：非法名字回落默认沙箱，不把路径段写进目录。 */
export const ISOLATION_NAME_RE = /^[A-Za-z0-9_-]{1,32}$/;

export function sanitizeIsolationName(raw) {
  const name = typeof raw === 'string' ? raw.trim() : '';
  return ISOLATION_NAME_RE.test(name) ? name : '';
}

export function looksLikeCindyManagedUserDataDir(dir) {
  const base = path.basename(path.resolve(dir));
  return /^(Cindy|CindyGlobal|CindyDev)(?:-dev2(?:-[A-Za-z0-9_-]+)?)?$/i.test(base);
}

/** Named `--isolated=<name>` must not inherit another Cindy profile. Custom dirs stay. */
export function inheritedUserDataBlocksNamedIsolation(isolatedArg, envUserDataDir, derivedDir) {
  if (!envUserDataDir || !isolatedArg || !isolatedArg.includes('=')) return false;
  if (!looksLikeCindyManagedUserDataDir(envUserDataDir)) return false;
  return canonicalizeUserDataDir(envUserDataDir) !== canonicalizeUserDataDir(derivedDir);
}

function volumeIsCaseInsensitive(existingDir) {
  let dir = existingDir;
  for (;;) {
    const parent = path.dirname(dir);
    const atRoot = parent === dir;
    if (!atRoot) {
      try {
        if (fs.statSync(parent).dev !== fs.statSync(dir).dev) return false;
      } catch {
        return false;
      }
    }
    const name = path.basename(dir);
    const flipped = name.replace(/[a-zA-Z]/g, (ch) => (
      ch === ch.toLowerCase() ? ch.toUpperCase() : ch.toLowerCase()
    ));
    if (flipped !== name) {
      try {
        return fs.realpathSync.native(path.join(parent, flipped))
          === fs.realpathSync.native(dir);
      } catch {
        return false;
      }
    }
    if (atRoot) return false;
    dir = parent;
  }
}

function foldCaseOption(dir) {
  try {
    fs.statSync(dir);
    return { foldCase: volumeIsCaseInsensitive(dir) };
  } catch {
    return {};
  }
}

export function canonicalizeUserDataDir(dir) {
  const resolved = path.resolve(dir);
  try {
    const real = fs.realpathSync.native(resolved);
    return volumeIsCaseInsensitive(real) ? real.toLowerCase() : real;
  } catch {
    // 叶子还不存在:沿最近存在祖先做 realpath,再按该卷语义接回剩余段。
  }
  let current = resolved;
  const suffix = [];
  for (;;) {
    const parent = path.dirname(current);
    suffix.unshift(path.basename(current));
    if (parent === current) return resolved;
    current = parent;
    try {
      const ancestorReal = fs.realpathSync.native(current);
      const joined = path.join(ancestorReal, ...suffix);
      return volumeIsCaseInsensitive(ancestorReal) ? joined.toLowerCase() : joined;
    } catch {
      // 继续上溯
    }
  }
}

export function isOfficialProductionUserDataDir(dir) {
  const resolved = canonicalizeUserDataDir(dir);
  return officialProductionUserDataDirs().some(
    (official) => canonicalizeUserDataDir(official) === resolved,
  );
}

export function resolveRestartTargetUserDataDir({
  envUserDataDir,
  isolatedArg,
  isolatedEnv,
  isolatedName,
  selectedRegion,
  rootDir: targetRoot = rootDir,
}) {
  const resolvedIsolatedArg = resolveIsolatedArg(isolatedArg, targetRoot, foldCaseOption(targetRoot));
  const isolationName = sanitizeIsolationName(
    resolvedIsolatedArg ? parseIsolationName(resolvedIsolatedArg) : isolatedName,
  );
  const isolated = Boolean(resolvedIsolatedArg) || isolatedEnv === '1';
  return envUserDataDir
    || (isolated
      ? defaultIsolatedUserDataDir(isolationName, selectedRegion)
      : productionUserDataDir(selectedRegion));
}

/**
 * Credential cleanup/write access is more destructive than ordinary isolated
 * startup. Trust only the v2 sandbox selected by this restart invocation; an
 * ambient userData path must not gain that authority by spoofing the epoch.
 */
export function isTrustedIsolatedAuthUserDataDir({
  isolatedArg,
  userDataDir,
  userDataDirEpoch,
  userDataDerivedByRestart,
  selectedRegion,
}) {
  if (
    !isolatedArg
    || !userDataDir
    || userDataDirEpoch !== '1'
    || userDataDerivedByRestart !== true
  ) {
    return false;
  }
  const expectedDir = defaultIsolatedUserDataDir(
    parseIsolationName(isolatedArg),
    selectedRegion,
  );
  if (userDataDirEntryIsAliasOrUnverifiable(userDataDir)) return false;
  return canonicalizeUserDataDir(userDataDir) === canonicalizeUserDataDir(expectedDir);
}

function userDataDirEntryIsAliasOrUnverifiable(dir) {
  try {
    return fs.lstatSync(path.resolve(dir)).isSymbolicLink();
  } catch (error) {
    // A not-yet-created derived sandbox is valid at the early trust gate. Every other lstat
    // failure is ambiguous and must not authorize credential cleanup or OAuth writes.
    return error?.code !== 'ENOENT';
  }
}

/**
 * Mint a single-use proof only after this restart invocation derived and accepted the sandbox.
 * The nonce crosses Terminal/runner/Forge via env; the bound file is the second factor that an
 * inherited ambient env does not carry. Desktop consumes it from its actual app userData path.
 */
export function createIsolatedAuthLaunchProof({
  userDataDir,
  isolationName = '',
  now = Date.now(),
  nonce = randomBytes(32).toString('hex'),
}) {
  // Recheck at the write boundary: process cleanup between authorization and proof minting leaves
  // time for the derived directory to be swapped for a symlink / Windows junction.
  if (userDataDirEntryIsAliasOrUnverifiable(userDataDir)) {
    throw new Error('Refusing isolated-auth launch proof for a symlink or junction userData path');
  }
  const proofPath = path.join(userDataDir, ISOLATED_AUTH_LAUNCH_PROOF_FILE);
  const tempPath = `${proofPath}.${process.pid}.${nonce}.tmp`;
  const proof = {
    version: 1,
    nonce,
    userDataDir: canonicalizeUserDataDir(userDataDir),
    profileKind: 'isolated-sandbox',
    epoch: 1,
    isolationName,
    issuedAtMs: now,
    expiresAtMs: now + isolatedAuthLaunchProofTtlMs,
  };
  fs.rmSync(proofPath, { force: true });
  try {
    fs.writeFileSync(tempPath, `${JSON.stringify(proof)}\n`, { flag: 'wx', mode: 0o600 });
    fs.renameSync(tempPath, proofPath);
  } catch (error) {
    fs.rmSync(tempPath, { force: true });
    throw error;
  }
  return nonce;
}

/**
 * Refuse when restarting would suicide this checkout's host, or when a shared
 * start is hosted by another checkout's desktop-dev (same official profile).
 * Isolated start from another checkout is safe: kill scope is ownRootDir.
 */
export function shouldRefuseHostedRestart(ancestor, {
  preserveRunning,
  ownRootDir,
  isolated = false,
}) {
  if (!ancestor || preserveRunning) return false;
  if (commandContainsPath(ancestor.command, ownRootDir)) return true;
  return isolated !== true;
}

export function hostedRestartRefusal(ancestor, { ownRootDir }) {
  return commandContainsPath(ancestor.command, ownRootDir)
    ? {
      code: 'HOSTED_RESTART_REFUSED',
      message: "Refusing to restart from within this checkout's desktop dev process tree.",
    }
    : {
      code: 'HOSTED_SHARED_REFUSED',
      message: 'Cannot share official userData while hosted by another checkout desktop dev.',
    };
}

export function defaultIsolatedUserDataDir(isolationName, region = 'global') {
  // 目录纪元 v2(-dev2),与 devCliFlags.ts 的派生保持一字不差:#871 起隔离沙箱用
  // CindyDev 钥匙串身份,旧 -dev 目录留给旧 checkout(#912 review)。
  const baseName = desktopUserDataDirNameForRegion(region);
  return userDataDirNamed(`${baseName}-dev2${isolationName ? `-${isolationName}` : ''}`);
}

/** 非隔离 dev 与正式版共用的 userData 目录。 */
export function productionUserDataDir(region = 'global') {
  return userDataDirNamed(desktopUserDataDirNameForRegion(region));
}

function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code !== 'ESRCH';
  }
}

/**
 * --preserve-running 只有在目标 profile 的所有存活实例都明确声明同一区域时
 * 才能共享。旧记录没有 region，属于无法证明兼容，必须 fail closed。
 */
export function inspectSharedUserDataRegion(userDataDir, expectedRegion, processes = []) {
  const recordsDir = path.join(userDataDir, '.dev-instances');
  const liveRecords = [];
  try {
    for (const name of fs.readdirSync(recordsDir)) {
      if (!name.endsWith('.json')) continue;
      try {
        const record = JSON.parse(fs.readFileSync(path.join(recordsDir, name), 'utf8'));
        if (Number.isInteger(record?.pid) && isProcessAlive(record.pid)) liveRecords.push(record);
      } catch {
        // 损坏记录不能证明兼容；若确有 helper 占用，下面的 process guard 会拒绝。
      }
    }
  } catch {
    // 没有注册表时继续看进程扫描。
  }

  const incompatibleRecords = liveRecords.filter(
    (record) => record.region !== expectedRegion || typeof record.rootDir !== 'string',
  );
  if (incompatibleRecords.length > 0) {
    return {
      compatible: false,
      reason:
        `target userData has live instance record(s) with incompatible or unknown region: ` +
        incompatibleRecords
          .map(
            (record) =>
              `pid=${record.pid},region=${record.region ?? 'unknown'},` +
              `root=${record.rootDir ?? 'unknown'}`,
          )
          .join('; '),
    };
  }

  const scannedUsers = processes.filter((proc) => commandUsesUserDataDir(proc.command, userDataDir));
  const unprovenUsers = scannedUsers.filter(
    (proc) => !liveRecords.some((record) => commandContainsPath(proc.command, record.rootDir)),
  );
  if (unprovenUsers.length > 0) {
    return {
      compatible: false,
      reason:
        `target userData has active process(es) not covered by a live ` +
        `region=${expectedRegion} instance record: ` +
        unprovenUsers.map((proc) => `pid=${proc.pid}`).join(', '),
    };
  }
  return { compatible: true, reason: null };
}

function parseIsolationName(isolatedArg) {
  if (!isolatedArg || !isolatedArg.includes('=')) return '';
  return isolatedArg.slice('--isolated='.length);
}

function devScriptForMode(mode) {
  return mode === 'local' ? 'dev:desktop' : 'dev:desktop:remote';
}

function packageManagerCommand(mode) {
  const runnerPath = path.join(rootDir, 'scripts', 'desktop-dev-runner.mjs');
  if (process.platform === 'win32') {
    return `${cmdDoubleQuote(process.execPath)} ${cmdDoubleQuote(runnerPath)} ${mode}`;
  }
  return `${shellSingleQuote(process.execPath)} ${shellSingleQuote(runnerPath)} ${shellSingleQuote(mode)}`;
}

function darwinEnvPrefix() {
  const corepackShimDir = path.resolve(path.dirname(process.execPath), '..', 'lib', 'node_modules', 'corepack', 'shims');
  const pnpmExecPath = process.env.npm_execpath;
  const preferredPathParts = [
    pnpmExecPath ? path.dirname(pnpmExecPath) : null,
    path.dirname(process.execPath),
  ].filter(Boolean);
  // corepack shims 只能放在 "$PATH" 之后兜底:它的 pnpm 版本由 corepack 自己决定,
  // 排在用户 PATH 前面会盖掉用户自己装好的 pnpm(proto / homebrew 等),
  // corepack 默认版本漂到 pnpm 11 后就会撞本仓 engines 上限炸掉 dev 启动。
  const fallbackPathParts = [
    ...(fs.existsSync(corepackShimDir) ? [corepackShimDir] : []),
    '/opt/homebrew/bin',
    '/opt/homebrew/sbin',
    '/usr/local/bin',
    '/usr/bin',
    '/bin',
    '/usr/sbin',
    '/sbin',
  ];

  return `export PATH=${shellSingleQuote([...new Set(preferredPathParts)].join(path.delimiter))}:"$PATH":${shellSingleQuote([...new Set(fallbackPathParts)].join(path.delimiter))}; `;
}

export function devEnvPrefix(env = process.env, platform = process.platform) {
  const envEntries = [
    // Electron Forge/Vite 在 Windows 新开的 cmd 中不会自动继承启动脚本的
    // Node 参数；显式透传堆上限，避免大型 renderer 编译回落到默认约 4 GB。
    ['NODE_OPTIONS', env.NODE_OPTIONS],
    // --region 经 CINDY_AUTH_REGION 注入 dev-remote-env / Forge / Vite，同一个值
    // 同时决定区域身份与 --endpoints-cdn 的自举 CDN 基址。
    ['CINDY_AUTH_REGION', env.CINDY_AUTH_REGION],
    ['XDT_VOICE_INPUT_RECORD', env.XDT_VOICE_INPUT_RECORD],
    // 登录 scenario harness(dev-only 状态遍历,implementation-plan Step 0):
    // XDT_LOGIN_SCENARIO 由 authManager 消费(附录 A 值域);
    // VITE_SPLASH_PHASE_FIXTURE 由 renderer useSplash fixture 读取点消费
    // (Vite 会把进程级 VITE_* 暴露进 import.meta.env,dev-only)。
    ['XDT_LOGIN_SCENARIO', env.XDT_LOGIN_SCENARIO],
    ['VITE_SPLASH_PHASE_FIXTURE', env.VITE_SPLASH_PHASE_FIXTURE],
    ['XDT_USER_DATA_DIR', env.XDT_USER_DATA_DIR],
    ['XDT_USER_DATA_DIR_EPOCH', env.XDT_USER_DATA_DIR_EPOCH],
    ['XDT_DEVICE_ID_OVERRIDE', env.XDT_DEVICE_ID_OVERRIDE],
    ['XDT_SCHEDULER_PASSIVE', env.XDT_SCHEDULER_PASSIVE],
    ['XDT_ISOLATED', env.XDT_ISOLATED],
    ['XDT_ISOLATED_NAME', env.XDT_ISOLATED_NAME],
    // 沙箱凭证隔离(--isolated-auth):不与 ~/.codex 共享 auth 硬链,auth-adapters 消费。
    ['XDT_ISOLATED_AUTH', env.XDT_ISOLATED_AUTH],
    ['XDT_ALLOW_DEV_OAUTH_WRITE', env.XDT_ALLOW_DEV_OAUTH_WRITE],
    ['XDT_ISOLATED_AUTH_PROOF', env.XDT_ISOLATED_AUTH_PROOF],
    // CDP 端口覆写(bootstrap-electron 消费): 并行多开沙箱时给后起实例换端口。
    ['XDT_CDP_PORT', env.XDT_CDP_PORT],
    // A long-lived Terminal can retain a previous smoke run's environment.
    // Override its value even when this invocation did not request the smoke.
    ['CINDY_CUA_SMOKE', env.CINDY_CUA_SMOKE === '1' ? '1' : '0'],
    // 一次性 Grok wire 归因探针(dev-only;正常环境不设置,不产生额外日志)。
    ['XDT_WIRE_DIAGNOSTICS', env.XDT_WIRE_DIAGNOSTICS],
    // 一次性 Grok strict tool spike(dev-only;必须与 wire probe 一起显式开启)。
    ['XDT_WIRE_DIAGNOSTICS_STRICT', env.XDT_WIRE_DIAGNOSTICS_STRICT],
    ['CINDY_IOS_SIMULATOR_NATIVE_H264', env.CINDY_IOS_SIMULATOR_NATIVE_H264],
    ['CINDY_IOS_SIMULATOR_NATIVE_HID', env.CINDY_IOS_SIMULATOR_NATIVE_HID],
    ['CINDY_REMOTE_CREDENTIALS_SIGNING_IDENTITY', env.CINDY_REMOTE_CREDENTIALS_SIGNING_IDENTITY],
    ['XDT_TAPDB_DEV', env.XDT_TAPDB_DEV],
    // 端点清单来源覆写:--endpoints-cdn(dev 走线上 CDN)/ local 模式的
    // endpoint.local.json 文件路径,均由主进程 clientEndpointsService 消费。
    ['XDT_ENDPOINTS_CDN', env.XDT_ENDPOINTS_CDN],
    ['XDT_ENDPOINT_MANIFEST_FILE', env.XDT_ENDPOINT_MANIFEST_FILE],
    // 模型目录闭环调试覆写。dev 默认仍不联网；只有显式给 URL 时，主进程才允许
    // 从该地址拉取 Catalog。PATH / DISABLE 同步透传，避免 runner 吞掉已有契约。
    ['XDT_MODELS_URL', env.XDT_MODELS_URL],
    ['XDT_MODELS_PATH', env.XDT_MODELS_PATH],
    ['XDT_DISABLE_MODELS_FETCH', env.XDT_DISABLE_MODELS_FETCH],
    // 启动即自动打开 DevTools(main 的 ready-to-show 里消费;见 bootstrap-electron)。
    // 给"快捷键/菜单打不开 DevTools"的环境兜底,QA 控制台验证依赖它。
    ['OPEN_DEVTOOLS', env.OPEN_DEVTOOLS],
    // --wait-ready 的一次性状态文件：runner 写失败，Electron main ready-to-show 写成功。
    ['XDT_DESKTOP_DEV_STARTUP_STATUS_FILE', env.XDT_DESKTOP_DEV_STARTUP_STATUS_FILE],
    // 插件存储启动边界的 dev 黑盒验收：仅显式临时结果路径时启用。
    ['XDT_PLUGIN_STORAGE_SMOKE_RESULT_FILE', env.XDT_PLUGIN_STORAGE_SMOKE_RESULT_FILE],
  ].filter(([, value]) => value);

  if (platform === 'win32') {
    return envEntries
      .map(([key, value]) => `set "${key}=${String(value).replaceAll('"', '')}" && `)
      .join('');
  }

  return envEntries
    .map(([key, value]) => `${key}=${shellSingleQuote(String(value))}`)
    .join(' ') + ' ';
}

function launchInSystemTerminal(mode) {
  if (process.platform === 'win32') {
    const command = `cd /d ${cmdDoubleQuote(rootDir)} && ${devEnvPrefix()}${packageManagerCommand(mode)}`;
    // 调试启动命令统一放在项目 .workbuddy，避免污染 scripts 目录。
    try { fs.writeFileSync(path.join(rootDir, '.workbuddy', 'restart', 'debug-dev-window-command.txt'), command); } catch {}
    const script = [
      "Start-Process -FilePath 'cmd.exe'",
      `-ArgumentList @('/c', ${psSingleQuote(command)})`,
      `-WorkingDirectory ${psSingleQuote(rootDir)}`,
    ].join(' ');
    const result = run('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script], {
      stdio: 'inherit',
      windowsHide: false,
    });
    if (result.status !== 0) {
      throw new Error(`Failed to open cmd window (exit ${result.status ?? 1})`);
    }
    console.log(`==> Opened desktop ${mode} dev in a new cmd window.`);
    return;
  }

  if (process.platform === 'darwin') {
    const command = `${darwinEnvPrefix()}cd ${shellSingleQuote(rootDir)} && ${devEnvPrefix()}${packageManagerCommand(mode)}; exitCode=$?; exit $exitCode`;
    const child = spawn('osascript', osascriptLaunchDarwinTerminalArgs(command), {
      detached: true,
      stdio: 'ignore',
    });
    child.unref();
    if (child.pid === undefined) {
      throw new Error('Failed to open Terminal.app');
    }
    console.log(`==> Opened desktop ${mode} dev in a new Terminal window.`);
    return;
  }

  console.warn('==> Non-interactive terminal detected, but no system terminal launcher is configured for this platform.');
  console.warn('==> Falling back to current process; this may fail if electron-forge requires a TTY.');
}

function startDesktopDev(mode) {
  console.log(`==> Starting desktop ${mode} dev...`);

  // 2026-09-15：无窗口模式（XDT_DEV_LAUNCH_HEADLESS=1，托盘「重启程序」使用）。
  // 默认无 TTY 时走 launchInSystemTerminal 新建一个控制台窗口——那样点 N 次重启
  // 就会累计 N 个窗口。无窗口模式改为由本进程直接托管 runner，输出重定向到
  // .workbuddy/restart/dev-console.log，既不弹窗也不丢日志。
  const headlessLaunch = process.env.XDT_DEV_LAUNCH_HEADLESS === '1';
  if (headlessLaunch) {
    const consoleLogPath = path.join(rootDir, '.workbuddy', 'restart', 'dev-console.log');
    fs.mkdirSync(path.dirname(consoleLogPath), { recursive: true });
    const consoleLogFd = fs.openSync(consoleLogPath, 'a');
    console.log(`==> Headless dev launch: console output -> ${consoleLogPath}`);
    const headlessChild = spawn(
      process.execPath,
      [path.join(rootDir, 'scripts', 'desktop-dev-runner.mjs'), mode],
      { cwd: rootDir, stdio: ['ignore', consoleLogFd, consoleLogFd], windowsHide: true, env: process.env },
    );
    headlessChild.on('exit', (code, signal) => {
      if (process.env.XDT_DESKTOP_DEV_STARTUP_STATUS_FILE) return;
      if (signal) process.kill(process.pid, signal);
      process.exit(code ?? 0);
    });
    return;
  }

  if (!hasInteractiveTty() && (process.platform === 'win32' || process.platform === 'darwin')) {
    launchInSystemTerminal(mode);
    return;
  }

  const child = spawn(process.execPath, [path.join(rootDir, 'scripts', 'desktop-dev-runner.mjs'), mode], {
    cwd: rootDir,
    stdio: 'inherit',
    windowsHide: false,
    env: process.env,
  });

  child.on('exit', (code, signal) => {
    // --wait-ready owns the process exit so it can print DESKTOP_DEV_VERDICT.
    if (process.env.XDT_DESKTOP_DEV_STARTUP_STATUS_FILE) return;
    if (signal) process.kill(process.pid, signal);
    process.exit(code ?? 0);
  });
}

function createStartupStatusPath() {
  return path.join(
    os.tmpdir(),
    `cindy-desktop-startup-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.json`,
  );
}

export function readDesktopStartupStatus(statusPath) {
  try {
    const parsed = JSON.parse(fs.readFileSync(statusPath, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

export function formatDesktopStartupFailure(status) {
  const code = typeof status?.code === 'string' ? status.code : 'DEV_PROCESS_EXITED';
  const message = typeof status?.message === 'string'
    ? status.message
    : 'Desktop dev exited before window/auth/database startup completed.';
  const detail = status?.detail && typeof status.detail === 'object'
    ? Object.entries(status.detail)
      .map(([key, value]) => `${key}=${String(value)}`)
      .join(', ')
    : '';
  const processExit = status?.exitCode !== undefined || status?.signal
    ? ` exit=${status.exitCode ?? 'unknown'}${status.signal ? ` signal=${status.signal}` : ''}`
    : '';
  return `[${code}] ${message}${detail ? ` (${detail})` : ''}${processExit}`;
}

function writeDesktopStartupStatus(statusPath, status) {
  const tempPath = `${statusPath}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(tempPath, `${JSON.stringify(status)}\n`, { mode: 0o600 });
    fs.renameSync(tempPath, statusPath);
  } catch (error) {
    fs.rmSync(tempPath, { force: true });
    throw new Error(`Failed to write desktop startup status: ${error.message}`);
  }
}

function attachStartupFailure(error, status) {
  error.startupStatus = status ?? null;
  return error;
}

// 启动耗时锚点（启动优化 2026-09-15）：脚本模块求值时刻 ≈ 双击/cmd 进入后
// pnpm 拉起的时刻。与 waitForDesktopStartup 的 ready 时刻相减 = 用户感知的
// 「双击 → 界面可操作」总耗时，直接打印到启动控制台。
const launcherStartedAtMs = Date.now();

// 读取 fork 写入的备货状态文件（plugin-vite-fork 在备货起止同步写入；
// 缺失/损坏时返回 null，launcher 据此判断本轮是否有备货需要等待）。
function readStockingStatus() {
  try {
    const stockingStatusPath = path.join(
      rootDir,
      'apps',
      'desktop',
      '.vite',
      'build',
      '.xdt-stamps',
      'stocking-status.json',
    );
    const parsed = JSON.parse(fs.readFileSync(stockingStatusPath, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

function printStartupElapsed(label) {
  const elapsedSec = (Date.now() - launcherStartedAtMs) / 1000;
  // 绿色加粗：在成片普通日志里一眼看到最终启动耗时。
  console.log(chalk.green.bold(`==> Startup time: ${elapsedSec.toFixed(1)}s (${label})`));
}

// ── 后台备货等待（启动优化 2026-09-15）────────────────────────────────────
// server 模式首启时，fork 插件会在 postStart 后台重建 renderer prod 产物
// （buildSingleRenderer），完成时刷新 stamp 并写 stocking-status 终态。
// 此前 launcher ready 即返回，外层自动化任务的进程树终止会把 dev server 一并
// 杀掉：实测 main_window 备货 7 次启动仅 1 次完成，stamp 长期陈旧，之后每轮
// 都回落 server 模式（首屏 60s+），用户感知即「改一次代码一直一分多钟」。
// 这里在 ready 后继续等待本轮备货完成/失败再返回（窗口此刻已可操作，等待
// 不影响使用），保证下一轮必进快启。
const stockingPollIntervalMs = 2000;
const stockingTimeoutMs = 600_000;

// 判断 Electron 主进程是否仍存活（未知 pid 时视为存活，避免误中断等待）。
function isElectronPidAlive(pid) {
  if (!pid || typeof pid !== 'number') return true;
  const probe = spawnSync('tasklist', ['/FI', `PID eq ${pid}`, '/NH'], { encoding: 'utf8' });
  if (probe.status !== 0) return true;
  const pidColumns = String(probe.stdout ?? '')
    .split(/\r?\n/)
    .map((line) => line.trim().split(/\s+/)[1])
    .filter(Boolean);
  return pidColumns.includes(String(pid));
}

// 等待本轮后台备货完成（基于 fork 写入的 stocking-status.json）；
// 本轮没有安排备货（快启/产物新鲜）时立即返回。
async function waitForBackgroundRendererStocking(status) {
  const waitStartedAtMs = Date.now();
  let sawRunning = false;
  while (Date.now() - waitStartedAtMs < stockingTimeoutMs) {
    const stockingStatus = readStockingStatus();
    if (
      stockingStatus?.state === 'running' &&
      (stockingStatus.startedAt ?? 0) >= launcherStartedAtMs
    ) {
      // 本轮备货进行中：首次见到时打印等待提示。
      if (!sawRunning) {
        sawRunning = true;
        console.log(
          `==> Waiting for background renderer stocking${
            stockingStatus.target ? ` (${stockingStatus.target})` : ''
          } to finish…`,
        );
      }
    } else if (sawRunning || (stockingStatus?.finishedAt ?? 0) >= launcherStartedAtMs) {
      // 本轮备货已出终态。
      if (stockingStatus?.state === 'failed') {
        console.warn('==> Renderer stocking FAILED; see dev-window.log for details. Continuing.');
      } else {
        const finishedSec = stockingStatus?.durationMs
          ? ` +${(stockingStatus.durationMs / 1000).toFixed(1)}s`
          : '';
        console.log(chalk.green(`==> Renderer stocking finished${finishedSec} (next launch fast-start)`));
      }
      return;
    } else {
      // 状态文件缺失/陈旧（快启或上一轮遗留），本轮无需等待。
      return;
    }
    if (!isElectronPidAlive(status?.pid)) {
      console.warn('==> Electron exited during stocking wait; skipping remaining wait.');
      return;
    }
    await sleep(stockingPollIntervalMs);
  }
  console.warn(
    `==> Renderer stocking wait timed out after ${Math.round(stockingTimeoutMs / 1000)}s; continuing.`,
  );
}

export async function waitForDesktopStartup(statusPath, timeoutMs = startupReadyTimeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const status = readDesktopStartupStatus(statusPath);
    if (status?.state === 'ready') {
      console.log(`==> Desktop dev is ready (window + auth/local database, pid ${status.pid ?? 'unknown'}).`);
      printStartupElapsed('launcher start → window + auth/database ready (UI operable)');
      // ready 后等本轮后台备货完成再返回：否则进程树终止会打断备货，stamp
      // 永不刷新，下一轮继续慢速 server 模式（见 waitForBackgroundRendererStocking 注释）。
      await waitForBackgroundRendererStocking(status);
      fs.rmSync(statusPath, { force: true });
      return status;
    }
    if (status?.state === 'failed') {
      fs.rmSync(statusPath, { force: true });
      throw attachStartupFailure(
        new Error(
          `${formatDesktopStartupFailure(status)} Check the dev terminal, run \`pnpm desktop:whoami\`, and inspect apps/desktop/logs/.`,
        ),
        status,
      );
    }
    await sleep(pollIntervalMs);
  }
  // Keep a tombstone so a late Electron startup signal cannot recreate a stale
  // status file after this waiter has already reported timeout to its caller.
  writeDesktopStartupStatus(statusPath, { state: 'abandoned', at: Date.now() });
  throw attachStartupFailure(
    new Error(
      `Desktop dev did not finish window/auth/database startup within ${Math.round(timeoutMs / 1000)}s. Check the dev terminal and apps/desktop/logs/.`,
    ),
    {
      state: 'failed',
      code: 'STARTUP_TIMEOUT',
      message: `Desktop dev did not finish window/auth/database startup within ${Math.round(timeoutMs / 1000)}s.`,
    },
  );
}

/**
 * The kill-only phase controls existing processes but does not launch Desktop.
 * Skipping startup initialization keeps that phase from printing default
 * region/endpoint values that can contradict the following real startup.
 */
export function applyDesktopStartupConfigForPhase(options) {
  if (options.argv.includes('--kill-only')) return null;
  return applyDesktopDevStartupConfig(options);
}

export function clearInheritedIsolatedAuthAuthorization(env = process.env) {
  delete env.XDT_ISOLATED_AUTH;
  delete env.XDT_ALLOW_DEV_OAUTH_WRITE;
  delete env.XDT_ISOLATED_AUTH_PROOF;
}

async function main() {
  // These capabilities are granted below only for this invocation's accepted --isolated-auth.
  clearInheritedIsolatedAuthAuthorization();
  let argv = normalizeDesktopRestartArgv(process.argv.slice(2), process.env);
  const sharedArgvConflict = desktopRestartArgvConflictMessage(argv, process.env);
  if (sharedArgvConflict) throw new Error(sharedArgvConflict);
  const rawIsolatedArg = argv.find((arg) => arg === '--isolated' || arg.startsWith('--isolated='));
  const isolatedArg = resolveIsolatedArg(rawIsolatedArg, rootDir, foldCaseOption(rootDir));
  if (rawIsolatedArg && isolatedArg && isolatedArg !== rawIsolatedArg) {
    argv = argv.map((arg) => (arg === rawIsolatedArg ? isolatedArg : arg));
    console.log(`==> Isolated sandbox from worktree: ${parseIsolationName(isolatedArg)}`);
  }
  const killOnly = argv.includes('--kill-only');
  const fastSwitch = argv.includes('--fast-switch');
  const waitReady = argv.includes('--wait-ready');
  const preserveRunning = argv.includes('--preserve-running');
  // --clean: 显式清 vite 缓存(白屏等缓存异常时的手动兜底)。2026-09-11 启动提速:
  // 默认不再每次清缓存 —— node_modules/.vite 是 renderer 依赖预打包缓存,清掉后
  // renderer 首载要重跑全量 optimizeDeps,实测两次启动 renderer 分别 35s/64s 才到
  // localDb gate(见 apps/desktop/logs/main-2026-09-11.log);叠加 .vite 全量重删,
  // 冷启动白白多花 30-70s。缓存损坏的恢复路径 = `pnpm run restart:desktop:remote -- --clean`。
  const cleanCaches = argv.includes('--clean');
  const replaceRunningArg = argv.find((arg) => arg.startsWith('--replace-running-root='));
  const replaceRunningRoot = replaceRunningArg
    ? path.resolve(replaceRunningArg.slice('--replace-running-root='.length))
    : null;
  // --local 切换到本地模式(连 localhost:3333);缺省走 remote(连 xdt-api)。
  const mode = argv.includes('--local') ? 'local' : 'remote';
  const startupConfig = applyDesktopStartupConfigForPhase({ argv, mode });
  const selectedRegion = startupConfig?.region ?? resolveDesktopDevRegion(argv, process.env);
  let userDataDerivedByRestart = false;
  let isolatedAuthAuthorizedByRestart = false;
  if (isolatedArg && isolatedArg.includes('=')) {
    const derivedDir = defaultIsolatedUserDataDir(parseIsolationName(isolatedArg), selectedRegion);
    if (inheritedUserDataBlocksNamedIsolation(isolatedArg, process.env.XDT_USER_DATA_DIR, derivedDir)) {
      delete process.env.XDT_USER_DATA_DIR;
      delete process.env.XDT_USER_DATA_DIR_EPOCH;
      delete process.env.XDT_DEVICE_ID_OVERRIDE;
      delete process.env.XDT_ISOLATED_NAME;
      console.log(`==> Ignoring inherited Cindy profile so --isolated=${parseIsolationName(isolatedArg)} can use its own sandbox.`);
    }
  }
  const isolationName = isolatedArg ? parseIsolationName(isolatedArg) : '';
  const verdictContext = {
    rootDir,
    isolated: Boolean(isolatedArg) || process.env.XDT_ISOLATED === '1',
    sandbox: isolationName || undefined,
    local: mode === 'local',
    region: selectedRegion,
  };
  const exitWithFailure = (code, message, details = []) => {
    for (const line of details) console.error(line);
    printDesktopDevVerdict(buildDesktopDevVerdictFromFailure(new Error(message), {
      ...verdictContext,
      code,
    }));
    process.exit(1);
  };
  if (preserveRunning && killOnly) {
    throw new Error('--preserve-running cannot be combined with the internal --kill-only stage');
  }
  if (replaceRunningRoot && !preserveRunning) {
    throw new Error('--replace-running-root requires --preserve-running');
  }
  if (replaceRunningArg && !replaceRunningArg.slice('--replace-running-root='.length)) {
    throw new Error('--replace-running-root requires an absolute registered worktree path');
  }
  if (replaceRunningRoot) {
    const registeredRoots = repositoryWorktreePathsOnce().map((entry) => path.resolve(entry));
    if (!registeredRoots.includes(replaceRunningRoot)) {
      throw new Error(`--replace-running-root is not a registered repository worktree: ${replaceRunningRoot}`);
    }
    if (replaceRunningRoot === rootDir) {
      throw new Error('--replace-running-root cannot target the worktree that is starting the replacement');
    }
  }
  if (preserveRunning && mode === 'local') {
    throw new Error(
      '--preserve-running only supports remote mode: sharing remote login storage with a local auth server could invalidate the persisted credential',
    );
  }
  if (preserveRunning && hasIsolationIntent(argv, process.env)) {
    throw new Error(
      '--preserve-running reuses the current Cindy login via shared userData and cannot be combined with --isolated or XDT_ISOLATED=1',
    );
  }
  if (startupConfig && argv.includes(SHARED_USERDATA_ARG)) {
    console.log('==> Shared userData mode: dev keeps the legacy shared profile behavior instead of an isolated sandbox.');
  }
  if (startupConfig) {
    console.log(`==> Desktop region: ${startupConfig.region}`);
  }
  // --passive: 定时任务被动模式 —— 本实例不参与自动触发(交给同机 primary,
  // 典型场景多个 dev preview 与 release/primary 共享数据时 preview 让位)。
  // 实现方式是置 XDT_SCHEDULER_PASSIVE=1,经 devEnvPrefix 白名单透传进新开的
  // 系统终端 / 直接 spawn 的 dev 进程。
  if (startupConfig && (argv.includes('--passive') || preserveRunning)) {
    process.env.XDT_SCHEDULER_PASSIVE = '1';
    console.log(
      preserveRunning
        ? '==> Preserve-running preview: existing Cindy processes stay alive; this instance shares login/data and will not auto-fire schedules.'
        : '==> Scheduler passive mode: this instance will not auto-fire schedules.',
    );
  }
  // --endpoints-cdn: dev 不读仓内 config/endpoint.json,改走与 packaged 相同的
  // 线上 CDN 端点清单拉取链路(测线上清单)。实现方式是置 XDT_ENDPOINTS_CDN=1,
  // 经 devEnvPrefix 白名单透传,主进程 devCliFlags/clientEndpointsService 消费。
  // 注意 local 模式的 endpoint.local.json 生成不在本脚本——dev(local)脚本链里的
  // apps/desktop/scripts/dev-local-env.mjs 统一负责(human 直跑与 restart 同路径)。
  if (startupConfig?.endpointsCdn) {
    console.log(`==> Endpoints via CDN: dev will fetch the ${startupConfig.region} online endpoint manifest.`);
  } else if (startupConfig && startupConfig.endpointManifestFile) {
    console.log(`==> Endpoint manifest: ${startupConfig.endpointManifestFile}`);
  }
  // --isolated[=<名字>]: dev 使用独立的 userData 目录(数据库/登录态/会话全部与
  // 正式版隔离,首次要重新登录 Cindy 账号)。不带名字 = 当前区域默认沙箱;
  // 带名字 = 在区域沙箱名后追加 `-<名字>`,每个名字一条,可同时多开。
  // 实现:置 XDT_USER_DATA_DIR(主进程入口只在非 packaged 时应用,见
  // apps/desktop/src/main/index.ts),经 devEnvPrefix 白名单透传给 dev 进程。
  // 已手动设了 XDT_USER_DATA_DIR 时尊重用户的值,不覆盖。
  // 同时置 XDT_ISOLATED=1(开关)+ XDT_ISOLATED_NAME(名字,可选)把隔离意图带进
  // 主进程——开关与名字分离,名叫 "1" 的沙箱不会撞开关标记值(codex review P2)。
  // 主进程据此派生独立 deviceId(dev-[<名字>-]<机器指纹>,机器指纹只有主进程能取)
  // ——服务端登录凭证按 (user, device) 一对一存,不派生的话沙箱登录会覆盖正式版
  // 的续期凭证,同机互踢。
  if (startupConfig && isolatedArg) {
    if (isolationName && !/^[A-Za-z0-9_-]{1,32}$/.test(isolationName)) {
      exitWithFailure(
        'INVALID_ISOLATED_NAME',
        `Invalid --isolated name: "${isolationName}"`,
        [
          `==> Invalid --isolated name: "${isolationName}"`,
          '    Allowed: letters / digits / _ / -, max 32 chars. e.g. --isolated=feature-a',
        ],
      );
    }
    process.env.XDT_ISOLATED = '1';
    if (isolationName) process.env.XDT_ISOLATED_NAME = isolationName;
    if (!process.env.XDT_USER_DATA_DIR) {
      process.env.XDT_USER_DATA_DIR = defaultIsolatedUserDataDir(isolationName, selectedRegion);
      // 可信纪元信号:仅当目录由本脚本按 -dev2 纪元派生时携带,主进程据此允许
      // 显式 env 覆写命中纪元判定。用户手动设 XDT_USER_DATA_DIR(上面的分支不
      // 进入)或旧 checkout 启动都不带该信号 → 观察模式,防旧代码对同一显式
      // 路径以默认身份打开造成双身份互写(#912 review P1)。
      process.env.XDT_USER_DATA_DIR_EPOCH = '1';
      userDataDerivedByRestart = true;
    }
  }
  // --isolated-auth: 沙箱凭证隔离 —— 启动时清掉本沙箱旧 auth(共享硬链与独立孤岛
  // 都处理),再显式允许沙箱自己的 OAuth 写入；正式实例与本机 CLI 凭证不受影响。
  // 隔离沙箱里测登录流程时必用:共享硬链下沙箱登录会改写共用凭证文件,把正式版
  // 一起退登(2026-08-13 实测)。实现:置 XDT_ISOLATED_AUTH=1,经 devEnvPrefix
  // 白名单透传,maker-host auth-adapters 消费(仅非 packaged 生效)。
  if (startupConfig && argv.includes('--isolated-auth')) {
    if (!isolatedArg) {
      exitWithFailure(
        'INVALID_ISOLATED_NAME',
        '--isolated-auth requires --isolated: shared userData must not isolate credentials alone',
        ['==> --isolated-auth requires --isolated: 共享 userData 的实例不该单独隔离凭证'],
      );
    }
    if (!isTrustedIsolatedAuthUserDataDir({
      isolatedArg,
      userDataDir: process.env.XDT_USER_DATA_DIR,
      userDataDirEpoch: process.env.XDT_USER_DATA_DIR_EPOCH,
      userDataDerivedByRestart,
      selectedRegion,
    })) {
      exitWithFailure(
        'STARTUP_FAILED',
        '--isolated-auth requires a userData sandbox derived by this restart invocation',
        [
          '==> Refusing --isolated-auth for an inherited or explicit XDT_USER_DATA_DIR.',
          '    Unset XDT_USER_DATA_DIR and retry with --isolated-auth --isolated[=<name>].',
        ],
      );
    }
    process.env.XDT_ISOLATED_AUTH = '1';
    process.env.XDT_ALLOW_DEV_OAUTH_WRITE = '1';
    isolatedAuthAuthorizedByRestart = true;
    console.log('==> Isolated auth: this sandbox will NOT share codex OAuth credentials with ~/.codex.');
  }
  if (startupConfig) ensureDesktopEnv();

  const devAncestor = findDevAncestor();
  if (shouldRefuseHostedRestart(devAncestor, {
    preserveRunning,
    ownRootDir: rootDir,
    isolated: hasIsolationIntent(argv, process.env),
  })) {
    const refusal = hostedRestartRefusal(devAncestor, { ownRootDir: rootDir });
    exitWithFailure(
      refusal.code,
      refusal.message,
      [
        `==> ${refusal.message}`,
        `    ancestor pid ${devAncestor.pid}: ${devAncestor.command.slice(0, 180)}`,
        refusal.code === 'HOSTED_RESTART_REFUSED'
          ? '==> Ask the user to restart from the official Cindy app, another worktree, or an external terminal.'
          : '==> Use --isolated=@worktree, or --preserve-running if you explicitly want shared login.',
      ],
    );
  }
  if (devAncestor && !preserveRunning && isolatedArg) {
    console.log(
      `==> Hosted by another checkout's desktop dev pid ${devAncestor.pid}; this isolated restart will not stop that host.`,
    );
  }
  if (devAncestor && preserveRunning) {
    if (replaceRunningRoot && commandContainsPath(devAncestor.command, replaceRunningRoot)) {
      throw new Error(
        `Refusing to replace ${replaceRunningRoot}: the current command is hosted by that dev process tree`,
      );
    }
    console.log(
      `==> Current session is hosted by Cindy desktop dev pid ${devAncestor.pid}; preserving that process tree.`,
    );
  }

  // userData 冲突门:目标 userData 已被其他 checkout 的 dev 实例占用时中止。
  // 杀掉别人(旧全灭行为)会顶掉用户并行调试中的沙箱;共用同一份 userData 并行
  // 又会撞 SQLite / 登录态。两难之下唯一安全解是停下来让用户决定:换一个
  // --isolated 名字,或用户自己停掉那个实例。preserve-running 不进此门 ——
  // 它的语义就是共享 userData 的被动预览。检测是尽力而为:靠 helper 进程命令行
  // 上的 --user-data-dir,对方实例刚启动还没起 helper 时可能漏检。
  const targetUserDataDir = resolveRestartTargetUserDataDir({
    envUserDataDir: process.env.XDT_USER_DATA_DIR,
    isolatedArg,
    isolatedEnv: process.env.XDT_ISOLATED,
    isolatedName: process.env.XDT_ISOLATED_NAME,
    selectedRegion,
  });
  if (
    hasIsolationIntent(argv, process.env)
    && isOfficialProductionUserDataDir(targetUserDataDir)
  ) {
    throw new Error(
      `--isolated cannot use the official Cindy profile (${targetUserDataDir}). ` +
        'Omit XDT_USER_DATA_DIR, or point it at a sandbox directory.',
    );
  }
  if (startupConfig && hasIsolationIntent(argv, process.env)) {
    if (!process.env.XDT_USER_DATA_DIR) {
      process.env.XDT_USER_DATA_DIR = targetUserDataDir;
      process.env.XDT_USER_DATA_DIR_EPOCH = '1';
    }
    fs.mkdirSync(process.env.XDT_USER_DATA_DIR, { recursive: true });
    const isolationName = isolatedArg
      ? parseIsolationName(isolatedArg)
      : (process.env.XDT_ISOLATED_NAME || '');
    console.log(`==> Isolated dev user data${isolationName ? ` (sandbox "${isolationName}")` : ''}: ${process.env.XDT_USER_DATA_DIR}`);
  }
  if (!preserveRunning) {
    const conflicts = listDesktopDevProcessesOnce().filter(
      (proc) => !commandContainsPath(proc.command, rootDir)
        && commandUsesUserDataDir(proc.command, targetUserDataDir),
    );
    if (conflicts.length > 0) {
      exitWithFailure(
        'USERDATA_IN_USE',
        `Target userData is already in use by another checkout's dev instance: ${targetUserDataDir}`,
        [
          `==> Target userData is already in use by another checkout's dev instance: ${targetUserDataDir}`,
          ...conflicts.map((proc) => `    pid ${proc.pid}: ${proc.command.slice(0, 180)}`),
          '==> Refusing to stop processes outside this checkout. Pick a different sandbox',
          '    name (--isolated=<name>), or stop that instance yourself and re-run.',
        ],
      );
    }
  } else {
    const compatibility = inspectSharedUserDataRegion(
      targetUserDataDir,
      selectedRegion,
      listDesktopDevProcesses(),
    );
    if (!compatibility.compatible) {
      throw new Error(
        `--preserve-running cannot safely share ${targetUserDataDir}: ${compatibility.reason}. ` +
          'Restart the existing instance with the same region, or use an isolated sandbox.',
      );
    }
  }

  const allTargets = listDesktopDevProcesses();
  // kill 作用域 = 当前 checkout。其他 worktree / 命名沙箱的实例一律保留。
  const ownScope = partitionDesktopDevProcesses(allTargets, rootDir);
  const targets = replaceRunningRoot
    ? allTargets.filter((proc) => commandContainsPath(proc.command, replaceRunningRoot))
    : ownScope.targets;
  const darwinTerminalTtys = darwinTerminalTtysForProcesses(targets);

  if (!preserveRunning && !replaceRunningRoot && ownScope.preserved.length > 0) {
    console.log(
      `==> Preserving ${ownScope.preserved.length} Cindy desktop dev process(es) from other checkouts; this restart only touches ${rootDir}.`,
    );
  }

  if (preserveRunning && !replaceRunningRoot) {
    console.log(
      `==> Preserving ${allTargets.length} existing Cindy desktop dev process(es); the preview will start alongside them in passive mode.`,
    );
  } else if (replaceRunningRoot) {
    console.log(
      `==> Preserving ${allTargets.length - targets.length} other Cindy desktop dev process(es); replacing only ${replaceRunningRoot}.`,
    );
    if (targets.length === 0) {
      console.log('==> No running desktop dev processes were found for the requested replacement root.');
    } else {
      console.log(`==> Stopping ${targets.length} desktop dev process(es) from the requested replacement root...`);
      for (const target of targets) {
        console.log(`    kill ${target.pid}: ${target.command.slice(0, 180)}`);
        killProcess(target.pid);
      }

      const matchesReplacementRoot = (proc) => commandContainsPath(proc.command, replaceRunningRoot);
      const remainingForRoot = await waitForDesktopDevProcessesToExit(
        gracefulTimeoutMs,
        matchesReplacementRoot,
      );
      if (remainingForRoot.length > 0) {
        console.log(`==> Force stopping ${remainingForRoot.length} stubborn process(es) from the replacement root...`);
        for (const target of remainingForRoot) {
          console.log(`    ${forceKillLabel} ${target.pid}: ${target.command.slice(0, 180)}`);
          forceKillProcess(target.pid);
        }
      }

      const remainingAfterForce = await waitForDesktopDevProcessesToExit(
        forceTimeoutMs,
        matchesReplacementRoot,
      );
      if (remainingAfterForce.length > 0) {
        exitWithFailure(
          'STARTUP_FAILED',
          `Failed to stop ${remainingAfterForce.length} process(es) from ${replaceRunningRoot}; aborting restart.`,
          [
            `==> Failed to stop ${remainingAfterForce.length} process(es) from ${replaceRunningRoot}; aborting restart.`,
            ...remainingAfterForce.map((target) => `    still running ${target.pid}: ${target.command.slice(0, 180)}`),
          ],
        );
      }

      closeDarwinTerminalTtys(darwinTerminalTtys);
    }
  } else if (targets.length === 0) {
    console.log('==> No existing Cindy desktop dev processes found for this checkout.');
  } else {
    console.log(`==> Stopping ${targets.length} existing Cindy desktop dev process(es) from this checkout...`);
    for (const target of targets) {
      console.log(`    kill ${target.pid}: ${target.command.slice(0, 180)}`);
      killProcess(target.pid);
    }

    // 等待/强杀同样限定在本 checkout —— 不带过滤器会把其他 checkout 仍在跑的
    // 实例当成"顽固进程"逐个 SIGKILL 掉。
    const matchesOwnRoot = (proc) => commandContainsPath(proc.command, rootDir);
    const remainingAfterTerm = await waitForDesktopDevProcessesToExit(gracefulTimeoutMs, matchesOwnRoot);
    if (remainingAfterTerm.length > 0) {
      console.log(`==> Force stopping ${remainingAfterTerm.length} stubborn Cindy desktop dev process(es)...`);
      for (const target of remainingAfterTerm) {
        console.log(`    ${forceKillLabel} ${target.pid}: ${target.command.slice(0, 180)}`);
        forceKillProcess(target.pid);
      }
    }

    const remainingAfterForce = await waitForDesktopDevProcessesToExit(forceTimeoutMs, matchesOwnRoot);
    if (remainingAfterForce.length > 0) {
      exitWithFailure(
        'STARTUP_FAILED',
        `Failed to stop ${remainingAfterForce.length} Cindy desktop dev process(es); aborting restart.`,
        [
          `==> Failed to stop ${remainingAfterForce.length} Cindy desktop dev process(es); aborting restart.`,
          ...remainingAfterForce.map((target) => `    still running ${target.pid}: ${target.command.slice(0, 180)}`),
        ],
      );
    }

    closeDarwinTerminalTtys(darwinTerminalTtys);
  }

  if (killOnly) return;

  // 默认保留 vite 缓存(见上方 --clean 注释);fastSwitch / preserveRunning 语义不变。
  if (!preserveRunning && !fastSwitch && cleanCaches) clearDesktopDevCaches(rootDir);

  let startupStatusPath = null;
  if (waitReady) {
    startupStatusPath = createStartupStatusPath();
    writeDesktopStartupStatus(startupStatusPath, { state: 'pending', at: Date.now() });
    process.env.XDT_DESKTOP_DEV_STARTUP_STATUS_FILE = startupStatusPath;
  }
  if (isolatedAuthAuthorizedByRestart) {
    process.env.XDT_ISOLATED_AUTH_PROOF = createIsolatedAuthLaunchProof({
      userDataDir: process.env.XDT_USER_DATA_DIR,
      isolationName: process.env.XDT_ISOLATED_NAME || '',
    });
  }
  startDesktopDev(mode);
  if (startupStatusPath) {
    try {
      await waitForDesktopStartup(startupStatusPath);
      const report = collectDesktopWhoamiReport({
        rootDir,
        userDataDir: process.env.XDT_USER_DATA_DIR,
      });
      const verdict = buildDesktopDevVerdictFromWhoami(report, verdictContext);
      printDesktopDevVerdict(verdict);
      if (verdict.state !== 'ready') process.exit(1);
    } catch (error) {
      printDesktopDevVerdict(buildDesktopDevVerdictFromFailure(error, verdictContext));
      printStartupElapsed('launcher start → failed/timeout');
      console.error(error instanceof Error ? error.message : error);
      process.exit(1);
    }
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    printDesktopDevVerdict(buildDesktopDevVerdictFromFailure(error, {
      rootDir,
      ...restartContextFromArgv(process.argv.slice(2)),
    }));
    console.error(error);
    process.exit(1);
  });
}
