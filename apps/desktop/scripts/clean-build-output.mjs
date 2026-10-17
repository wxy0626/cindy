#!/usr/bin/env node
/**
 * clean-build-output.mjs — 打包前清理上一次的产物，保证 build/ 只保留最新一版。
 *
 * 背景：forge 默认不清空 outDir，`pnpm build` 反复执行会在产物目录里堆叠历史
 * 版本的 exe/安装包（外加 electron-packager 的临时目录），既占空间也容易让人
 * 误启动旧包。本脚本在每次 `pnpm build`（prebuild）前删除上一版产物：
 *
 *   apps/desktop/build        当前唯一正式产物目录（forge outDir）
 *   apps/desktop/out          历史产物目录（改 outDir 前遗留，一旦发现即删）
 *   apps/desktop/dist         electron-builder 的中间产物目录
 *
 * 安全边界：
 *   - 只删上述相对 apps/desktop 的三个目录，且必须解析为 apps/desktop 的直接子目录；
 *   - 目录不存在时静默跳过（首次构建 / 已清理）；
 *   - 拒绝在仓库根或 HOME 上执行任何删除；
 *   - 支持 --dry-run 只打印将要删除的路径。
 *
 * 用法：
 *   node apps/desktop/scripts/clean-build-output.mjs [--dry-run]
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const desktopDir = path.resolve(__dirname, '..');
const repoRoot = path.resolve(desktopDir, '..', '..');
const dryRun = process.argv.includes('--dry-run');

/** 与 forge.config.ts 的 outDir 保持一致；改动那里时同步这里。 */
const TARGETS = ['build', 'out', 'dist'];

function dirSize(target) {
  let total = 0;
  const stack = [target];
  while (stack.length) {
    const current = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else {
        try {
          total += fs.statSync(full).size;
        } catch {
          /* 忽略并发删除的文件 */
        }
      }
    }
  }
  return total;
}

function assertSafe(target) {
  const relative = path.relative(desktopDir, target);
  if (relative !== path.basename(target) || relative.startsWith('..')) {
    throw new Error(`Refusing to delete outside apps/desktop: ${target}`);
  }
  if (target === repoRoot || target === desktopDir || target === path.dirname(repoRoot)) {
    throw new Error(`Refusing to delete protected path: ${target}`);
  }
}

const removed = [];
for (const name of TARGETS) {
  const target = path.join(desktopDir, name);
  if (!fs.existsSync(target)) continue;
  if (!fs.statSync(target).isDirectory()) continue;
  assertSafe(target);
  const sizeMb = (dirSize(target) / 1024 / 1024).toFixed(0);
  if (dryRun) {
    console.log(`[clean-build] would remove ${target} (${sizeMb} MB)`);
  } else {
    fs.rmSync(target, { recursive: true, force: true });
    console.log(`[clean-build] removed ${target} (${sizeMb} MB)`);
  }
  removed.push(name);
}

if (!removed.length) {
  console.log('[clean-build] nothing to remove — workspace is already clean');
} else if (!dryRun) {
  console.log('[clean-build] previous artifacts cleared; build will produce a single fresh copy');
}
