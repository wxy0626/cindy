/**
 * localProfileSharedRootSeeder — 本机会话库跨区域共享根的一次性存量播种。
 *
 * 背景：本特性把「会话库」（sessions/messages 索引，localDb）从「各自区域目录」
 * 切到「跨区域共享根 CindyShared」（见 localProfileSharedRoot.ts）。切换前用户可能
 * 已经在中国版 / 国际版各自的目录里攒下过库文件（如 %APPDATA%\Cindy\cindy-<云owner>.db
 * 与 %APPDATA%\CindyGlobal\cindy-local-v1.db）。若不搬，用户升级后会发现本机攒下的
 * 会话/项目"凭空消失"——它们其实还躺在旧目录里。
 *
 * 本模块在启动早期（打开共享库之前）把各正式区域目录中的全部会话库文件组播种进共享根：
 *
 *   - 扫描 cn / global / dev 三个正式区域目录（按固定顺序），收集所有
 *     `<dbFilePrefix>-<ownerId>.db` 的 owner（云账号 + local-v1 免登录档案）；
 *   - 共享根里若还没有某个 owner 的主库，就把该 owner 的整组文件（.db 及其
 *     WAL/shm 伴随文件；local-v1 另含认领 marker）**复制**过去（保留源文件，绝不删除）；
 *   - 已存在则直接跳过——天然幂等，重启不重复、不覆盖。
 *
 * 安全边界（改动前必读）：
 *  1. **只复制、不移动、不删除源文件**。源文件保留意味着即使共享根被破坏，数据仍在
 *     旧位置可抢救；也避免与仍按旧路径运行的旧版本实例并发写同一文件组。
 *  2. **先到先得**。同一 owner 在多个区域目录都有库时，只播种第一个命中的
 *     （cn → global → dev），后到的跳过。本机同一份库本应只有一份，冲突场景罕见；
 *     宁可保守不覆盖。
 *  3. **best-effort**。任何文件操作失败只记录日志，绝不 throw——存量播种失败不能阻断
 *     用户正常启动。
 *  4. 只搬**库文件**这一层（会话数据）。凭证命名空间（token / model-access-credentials）
 *     仍走 ownerScopedUserDataPath 按区域隔离，绝不因会话共享而跨区域串号
 *     （authManager 安全红线）。
 */

import fs from 'node:fs';
import path from 'node:path';

import {
  LOCAL_PROFILE_SHARED_DIR_NAME,
  resolveSessionDbRootDir,
} from './localProfileSharedRoot.js';
import { createLogger } from './logger.js';
import { LOCAL_PROFILE_DATA_OWNER_ID } from './profile/profileRegistryModel.js';
import { brandUserDataDirName, type CindyRegion } from '@cindy/maker-shared/brand-identity';

const log = createLogger('localProfileSharedRootSeeder');

/** 三个正式区域目录名，按固定优先级顺序遍历。 */
const REGION_SCAN_ORDER: readonly CindyRegion[] = ['cn', 'global', 'dev'];

/** 会话库文件组的固定成员（.db 主文件为组长，先判它）。 */
const DB_FILE_GROUP_SUFFIXES = ['.db', '.db-wal', '.db-shm'] as const;

/** local-v1 文件组额外成员：认领 marker（记录这份库被哪个云 owner 认领）。 */
const LOCAL_PROFILE_EXTRA_SUFFIXES = ['.local-profile-migration.json'] as const;

/** 与单测/外部共享的纯函数：某个文件是否属于某个 owner 的会话库文件组。 */
export function isSessionDbFileGroupMember(
  fileName: string,
  dbFilePrefix: string,
  ownerId: string,
): boolean {
  return DB_FILE_GROUP_SUFFIXES.some(
    (suffix) => fileName === `${dbFilePrefix}-${ownerId}${suffix}`,
  );
}

/**
 * 与单测/外部共享的纯函数：某个文件是否属于 local-v1 文件组（含认领 marker）。
 * 保留导出以兼容旧测试；新代码优先用 `isSessionDbFileGroupMember`。
 */
export function isLocalProfileFileGroupMember(fileName: string, dbFilePrefix: string): boolean {
  return (
    isSessionDbFileGroupMember(fileName, dbFilePrefix, LOCAL_PROFILE_DATA_OWNER_ID) ||
    LOCAL_PROFILE_EXTRA_SUFFIXES.some(
      (suffix) => fileName === `${dbFilePrefix}-${LOCAL_PROFILE_DATA_OWNER_ID}${suffix}`,
    )
  );
}

/**
 * 把指定 owner 的文件组复制进共享根（仅当主库尚未存在时）。返回本次实际复制的文件数。
 *
 * @param sharedRoot 共享根目录（由调用方保证已 mkdir）
 * @param regionDirs 按优先级排序的区域目录列表
 * @param dbFilePrefix 品牌库文件前缀（如 cindy）
 * @param ownerId 要播种的 owner
 */
function copyOwnerFileGroupToSharedRoot(
  sharedRoot: string,
  regionDirs: readonly string[],
  dbFilePrefix: string,
  ownerId: string,
): number {
  const suffixes =
    ownerId === LOCAL_PROFILE_DATA_OWNER_ID
      ? [...DB_FILE_GROUP_SUFFIXES, ...LOCAL_PROFILE_EXTRA_SUFFIXES]
      : DB_FILE_GROUP_SUFFIXES;
  const mainDbName = `${dbFilePrefix}-${ownerId}.db`;
  // 共享根已有主库 → 已播种过（或已由新版本正常运行产生），幂等跳过。
  if (fs.existsSync(path.join(sharedRoot, mainDbName))) return 0;

  for (const regionDir of regionDirs) {
    const mainDb = path.join(regionDir, mainDbName);
    if (!fs.existsSync(mainDb)) continue;

    const copied: string[] = [];
    try {
      for (const suffix of suffixes) {
        const source = path.join(regionDir, `${dbFilePrefix}-${ownerId}${suffix}`);
        if (!fs.existsSync(source)) continue;
        const target = path.join(sharedRoot, path.basename(source));
        // 目标已存在且非本次复制产物时跳过（组内成员逐个幂等）。
        if (copied.includes(target) || fs.existsSync(target)) continue;
        fs.copyFileSync(source, target);
        copied.push(target);
      }
    } catch (error) {
      log.error('partial session db seeding failure; source files are kept intact', {
        ownerId,
        regionDir,
        sharedRoot,
        copied,
        error: error instanceof Error ? error.message : String(error),
      });
      return copied.length;
    }

    log.info('seeded session db into shared root', {
      ownerId,
      sourceRegionDir: regionDir,
      sharedRoot,
      files: copied,
    });
    return copied.length;
  }

  return 0;
}

/** 判定某个 owner 是否需要在共享根播种：源侧有主库且共享根尚无该主库。 */
function needsSeeding(
  sharedRoot: string,
  regionDirs: readonly string[],
  dbFilePrefix: string,
  ownerId: string,
): boolean {
  const mainDbName = `${dbFilePrefix}-${ownerId}.db`;
  if (fs.existsSync(path.join(sharedRoot, mainDbName))) return false;
  return regionDirs.some((regionDir) => fs.existsSync(path.join(regionDir, mainDbName)));
}

/** 扫描区域目录，收集其中出现的全部会话库 owner（含 local-v1）。 */
function discoverSessionDbOwners(
  appDataRoot: string,
  dbFilePrefix: string,
): string[] {
  const owners = new Set<string>([LOCAL_PROFILE_DATA_OWNER_ID]);
  for (const region of REGION_SCAN_ORDER) {
    const regionDir = path.join(appDataRoot, brandUserDataDirName(region));
    let entries: string[];
    try {
      entries = fs.readdirSync(regionDir);
    } catch {
      continue; // 该区域从未运行过，目录不存在——跳过。
    }
    const prefix = `${dbFilePrefix}-`;
    for (const entry of entries) {
      if (!entry.startsWith(prefix) || !entry.endsWith('.db')) continue;
      const ownerId = entry.slice(prefix.length, -'.db'.length);
      if (ownerId) owners.add(ownerId);
    }
  }
  return [...owners];
}

/**
 * 把正式区域目录里的全部会话库文件组播种进跨区域共享根。
 *
 * 覆盖所有 owner：云账号库（登录状态）与 local-v1 免登录档案库一视同仁——只要
 * 本机出现过，就都进共享根，让切版本 / 切账号后侧边栏仍能看到全部本机会话。
 * 源侧完全没有可播种数据时不创建共享根目录（避免在 appData 下多出空目录）。
 *
 * @param currentUserDataDir 当前实例的 userData 目录（正式区域目录之一）
 * @param dbFilePrefix 品牌库文件前缀（如 cindy）
 * @returns 是否执行了播种（false = 共享根已有数据或源侧无数据）
 */
export function seedSessionDbSharedRoot(
  currentUserDataDir: string,
  dbFilePrefix: string,
): boolean {
  const sharedRoot = resolveSessionDbRootDir(LOCAL_PROFILE_DATA_OWNER_ID, currentUserDataDir);
  // 非正式区域目录（沙箱/自定义）退化为自身，无需播种，也不该播种。
  if (sharedRoot === currentUserDataDir) return false;

  const appDataRoot = path.dirname(currentUserDataDir);
  const regionDirs = REGION_SCAN_ORDER.map((region) =>
    path.join(appDataRoot, brandUserDataDirName(region)),
  );
  const owners = discoverSessionDbOwners(appDataRoot, dbFilePrefix);
  const pending = owners.filter((ownerId) =>
    needsSeeding(sharedRoot, regionDirs, dbFilePrefix, ownerId),
  );
  // 没有需要播种的 owner（共享根已齐 / 源侧无数据）→ 不创建空目录。
  if (pending.length === 0) return false;

  // mkdir 必须可靠；失败即整体放弃（下次启动会重试），但绝不能 throw 阻断启动。
  try {
    fs.mkdirSync(sharedRoot, { recursive: true });
  } catch (error) {
    log.error('failed to create shared root before seeding session db', {
      sharedRoot,
      error: error instanceof Error ? error.message : String(error),
    });
    return false;
  }

  let copiedAny = false;
  for (const ownerId of pending) {
    copiedAny =
      copyOwnerFileGroupToSharedRoot(sharedRoot, regionDirs, dbFilePrefix, ownerId) > 0 ||
      copiedAny;
  }
  return copiedAny;
}

/**
 * 仅播种 local-v1（免登录档案）文件组。新版本统一走 `seedSessionDbSharedRoot`
 * （覆盖云账号 + local-v1）；本函数保留作兼容入口，行为等价于旧版。
 */
export function seedLocalProfileSharedRoot(
  currentUserDataDir: string,
  dbFilePrefix: string,
): boolean {
  const sharedRoot = resolveSessionDbRootDir(LOCAL_PROFILE_DATA_OWNER_ID, currentUserDataDir);
  if (sharedRoot === currentUserDataDir) return false;
  const regionDirs = REGION_SCAN_ORDER.map((region) =>
    path.join(path.dirname(currentUserDataDir), brandUserDataDirName(region)),
  );
  if (!needsSeeding(sharedRoot, regionDirs, dbFilePrefix, LOCAL_PROFILE_DATA_OWNER_ID)) {
    return false;
  }
  try {
    fs.mkdirSync(sharedRoot, { recursive: true });
  } catch (error) {
    log.error('failed to create shared root before seeding local profile', {
      sharedRoot,
      error: error instanceof Error ? error.message : String(error),
    });
    return false;
  }
  return (
    copyOwnerFileGroupToSharedRoot(sharedRoot, regionDirs, dbFilePrefix, LOCAL_PROFILE_DATA_OWNER_ID) >
    0
  );
}
