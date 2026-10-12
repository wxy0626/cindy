/**
 * 本机共享数据路径。
 *
 * 这些数据没有云账号归属：无账号登录、切换账号和切换正式区域后都应继续可见。
 * 账号凭证与其它私有状态仍由 ownerScopedUserDataPath 单独保存，不能复用这里的路径。
 */
import { app } from 'electron';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { LOCAL_PROFILE_DATA_OWNER_ID } from './profile/profileRegistryModel.js';
import { resolveOwnerDataRootDir } from './localProfileSharedRoot.js';

function localOwnerStorageKey(): string {
  return crypto
    .createHash('sha256')
    .update(LOCAL_PROFILE_DATA_OWNER_ID)
    .digest('hex')
    .slice(0, 20);
}

/**
 * 返回本机共享命名空间。
 *
 * 正式构建落在跨区域的 CindyShared；标准开发隔离实例统一落在稳定的
 * `Cindy*-dev2-dev` 共享根，因而不同对话/不同 worktree 不会切出另一份本机数据。
 * 真正自定义 userData 仍由路径解析层保持隔离。
 */
export function machineSharedUserDataPath(...parts: string[]): string {
  const root = resolveOwnerDataRootDir(LOCAL_PROFILE_DATA_OWNER_ID, app.getPath('userData'));
  return path.join(root, 'owners', localOwnerStorageKey(), ...parts);
}

/** 返回当前实例可能遗留过本机共享文件的 owner 目录。 */
export function machineSharedOwnerDirectories(): string[] {
  const roots = new Set<string>([
    path.join(app.getPath('userData'), 'owners'),
    path.join(path.dirname(machineSharedUserDataPath()), ''),
  ]);
  const directories = new Set<string>();
  for (const ownersRoot of roots) {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(ownersRoot, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.isDirectory()) directories.add(path.join(ownersRoot, entry.name));
    }
  }
  return [...directories];
}

/** 查找尚未迁入共享命名空间的旧配置文件，按修改时间从新到旧返回。 */
export function machineSharedLegacyFileCandidates(...parts: string[]): string[] {
  const target = path.resolve(machineSharedUserDataPath(...parts));
  const candidates = new Set<string>([
    path.join(app.getPath('userData'), ...parts),
    ...machineSharedOwnerDirectories().map((ownerRoot) => path.join(ownerRoot, ...parts)),
  ]);
  return [...candidates]
    .filter((candidate) => path.resolve(candidate) !== target)
    .filter((candidate) => {
      try {
        return fs.statSync(candidate).isFile();
      } catch {
        return false;
      }
    })
    .sort((left, right) => {
      try {
        return fs.statSync(right).mtimeMs - fs.statSync(left).mtimeMs;
      } catch {
        return 0;
      }
    });
}
