/**
 * localProfileSharedRoot — 本地档案（local-v1）的跨区域共享数据根。
 *
 * 为什么需要这一层：cn / global 是两个可同机并存的系统身份，各自持有独立的
 * Electron userData 目录（`Cindy` / `CindyGlobal`，另见 regionUserData.ts）。
 * **云账号数据必须继续按区域隔离**——两区域后端与账号体系不同，凭证、会话、
 * refresh token 绝不能串（authManager.ts 注释明确要求"当前活动指针不能跨区域
 * 复用"）。但**免登录的本地档案**没有任何服务端归属：它只是"这台机器上、这个
 * 用户、还没登录时"攒下的对话与项目。把它锁死在某一个版本的目录里，用户一换
 * 版本数据就凭空消失。
 *
 * 于是本地档案单独走一个**区域无关**的共享根，三个正式构建身份共用同一份：
 *
 *   <appData>/CindyShared/cindy-local-v1.db
 *   <appData>/CindyShared/owners/<local-v1 命名空间>/…
 *
 * 语义边界（改动前必读，踩错任何一条都是数据事故）：
 *
 *  1. **只认 LOCAL_PROFILE_DATA_OWNER_ID**。任何云 ownerId 一律原样返回区域
 *     目录，行为与引入本模块前逐字符相同——云账号隔离是安全属性，不是默认值。
 *  2. **正式区域目录与标准开发沙箱参与本机共享**。正式区域目录是三个品牌目录；
 *     标准开发沙箱（`<区域目录>-dev2[-名字]`）统一归一到该区域稳定的
 *     `-dev2-dev` 目录。这样不同对话、不同 worktree 使用不同隔离名字时，仍然
 *     读取同一份本机共享会话/伙伴/供应商数据，不会再因启动参数变化而显示空库。
 *     真正自定义 userData（例如临时测试目录）仍退化为自身，避免测试污染用户数据。
 *  3. **正式版共享根目录名刻意不带区域后缀**。它不是"按区域派生的标识符"，
 *     因此不受 region-and-editions.md §2.1「无限定词身份归 Global」约束；开发
 *     沙箱则使用稳定的 `-dev2-dev` 根，避免开发启动参数改变数据身份。
 *  4. **共享根由 userDataDir 的父目录推出**，不读 Electron、不读环境变量：
 *     本模块保持零 Electron 依赖（与 regionUserData.ts 同一纪律），纯函数可
 *     直接单测，调用方不需要为了测试去 mock `app`。
 *  5. 本模块只回答"数据根在哪"，**不负责搬数据**。既有的历史数据采用由
 *     localProfileDataMigration 在他处负责，避免把原子文件操作混进路径计算。
 */

import path from 'node:path';

import { brandUserDataDirName, type CindyRegion } from '@cindy/maker-shared/brand-identity';

import { LOCAL_PROFILE_DATA_OWNER_ID } from './profile/profileRegistryModel.js';

/** 跨区域共享根的目录名（挂在 appData 基址下，与区域目录同级）。 */
export const LOCAL_PROFILE_SHARED_DIR_NAME = 'CindyShared';

/** 三个正式区域目录名；命中其一才认为这是正式身份的 userData。 */
const PRODUCTION_REGION_DIR_NAMES: ReadonlySet<string> = new Set(
  (['cn', 'global', 'dev'] as const satisfies readonly CindyRegion[]).map((region) =>
    brandUserDataDirName(region),
  ),
);

/** 标准开发沙箱的目录名：正式目录后追加 -dev2，后面可带一个隔离名称。 */
const DEVELOPMENT_SANDBOX_RE = /^(Cindy|CindyGlobal|CindyDev)-dev2(?:-[A-Za-z0-9_-]+)?$/i;

/**
 * userData 目录是否属于支持本机共享的区域身份。
 *
 * 标准开发沙箱也被视为本机共享身份；自定义目录和单测临时目录仍返回 false。
 */
export function isProductionRegionUserDataDir(userDataDir: string): boolean {
  const base = path.basename(userDataDir);
  return PRODUCTION_REGION_DIR_NAMES.has(base) || DEVELOPMENT_SANDBOX_RE.test(base);
}

/**
 * 把标准开发沙箱归一到稳定的 `-dev2-dev` 目录。
 *
 * `--isolated=@worktree` 和命名沙箱只改变 Electron 的缓存/凭证目录，
 * 不应改变本机共享库的身份。非标准目录返回 null，由调用方保持原隔离语义。
 */
export function resolveDevelopmentSharedUserDataDir(userDataDir: string): string | null {
  const base = path.basename(userDataDir);
  const match = base.match(/^(Cindy|CindyGlobal|CindyDev)-dev2(?:-[A-Za-z0-9_-]+)?$/i);
  if (!match) return null;
  return path.join(path.dirname(userDataDir), `${match[1]}-dev2-dev`);
}

/**
 * 解析某个 data owner 的数据根。
 *
 * 仅本地档案落共享根，其余 owner（含所有云账号）返回区域目录不变。
 * `ownerId` 为 null / undefined（会话尚未确定）时同样保持区域目录。
 */
export function resolveOwnerDataRootDir(
  ownerId: string | null | undefined,
  regionUserDataDir: string,
): string {
  if (!ownerId || ownerId !== LOCAL_PROFILE_DATA_OWNER_ID) return regionUserDataDir;
  const developmentShared = resolveDevelopmentSharedUserDataDir(regionUserDataDir);
  if (developmentShared) return developmentShared;
  if (!isProductionRegionUserDataDir(regionUserDataDir)) return regionUserDataDir;
  return path.join(path.dirname(regionUserDataDir), LOCAL_PROFILE_SHARED_DIR_NAME);
}

/**
 * 解析某个 data owner 的**会话库**数据根。
 *
 * 本机维度共享：这台机器上产生的会话（sessions/messages 索引库）不分区域、不分
 * 登录态、不分账号，统一落在共享根——用户切版本/切账号后侧边栏仍能看到全部本机
 * 会话。库文件名按 ownerId 区分（`<dbFilePrefix>-<ownerId>.db`，云账号 / local-v1
 * 各不相同），落在共享根天然互不覆盖、不碰撞。
 *
 * 与 `resolveOwnerDataRootDir` 的分工：
 *   - 本函数只管**库文件**这一层，任何 owner 都共享；
 *   - `resolveOwnerDataRootDir` 管**命名空间**层，仍只有 local-v1 共享、云账号按
 *     区域隔离——凭证（token、model-access-credentials 等）继续留在各自区域目录，
 *     绝不因会话共享而跨区域串号（authManager 安全红线）。
 *
 * 真正自定义目录退化为自身；标准开发沙箱已经在上面归一到稳定 dev2 根。
 */
export function resolveSessionDbRootDir(
  ownerId: string | null | undefined,
  regionUserDataDir: string,
): string {
  if (!ownerId) return regionUserDataDir;
  const developmentShared = resolveDevelopmentSharedUserDataDir(regionUserDataDir);
  if (developmentShared) return developmentShared;
  if (!isProductionRegionUserDataDir(regionUserDataDir)) return regionUserDataDir;
  return path.join(path.dirname(regionUserDataDir), LOCAL_PROFILE_SHARED_DIR_NAME);
}
