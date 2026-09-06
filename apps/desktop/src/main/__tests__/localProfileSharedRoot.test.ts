/**
 * localProfileSharedRoot 的路径解析契约。
 *
 * 这里锁的不是实现细节，而是三条数据安全的语义边界：
 *   1. 本地档案在正式区域目录之间必须落到**同一个**共享根（特性的全部意义）；
 *   2. 云账号必须纹丝不动地留在各自的区域目录（两区域后端不通，串了就是事故）；
 *   3. 隔离沙箱 / 自定义 userData 永远不参与共享（测试与沙箱不许碰真数据）。
 */

import path from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  LOCAL_PROFILE_SHARED_DIR_NAME,
  isProductionRegionUserDataDir,
  resolveOwnerDataRootDir,
  resolveSessionDbRootDir,
} from '../localProfileSharedRoot.js';
import { LOCAL_PROFILE_DATA_OWNER_ID } from '../profile/profileRegistryModel.js';

/** 两个正式区域目录（磁盘实测：%APPDATA%\Cindy 与 %APPDATA%\CindyGlobal）。 */
const CN_DIR = path.join('/AppData/Roaming', 'Cindy');
const GLOBAL_DIR = path.join('/AppData/Roaming', 'CindyGlobal');
const DEV_DIR = path.join('/AppData/Roaming', 'CindyDev');
const EXPECTED_SHARED = path.join('/AppData/Roaming', LOCAL_PROFILE_SHARED_DIR_NAME);

/** 一个典型的云账号 ownerId（与磁盘上的云库命名同形）。 */
const CLOUD_OWNER_ID = 'cmtl7ysug2kisw1016fhxrqi1';

describe('resolveOwnerDataRootDir', () => {
  it('本地档案在两个正式区域目录解析出同一个共享根', () => {
    const fromCn = resolveOwnerDataRootDir(LOCAL_PROFILE_DATA_OWNER_ID, CN_DIR);
    const fromGlobal = resolveOwnerDataRootDir(LOCAL_PROFILE_DATA_OWNER_ID, GLOBAL_DIR);
    expect(fromCn).toBe(EXPECTED_SHARED);
    expect(fromGlobal).toBe(EXPECTED_SHARED);
    // 特性的全部意义：切版本后拿到的是同一份本地档案数据。
    expect(fromCn).toBe(fromGlobal);
  });

  it('dev 正式目录同样共享，三个正式身份共用一份本地档案', () => {
    expect(resolveOwnerDataRootDir(LOCAL_PROFILE_DATA_OWNER_ID, DEV_DIR)).toBe(EXPECTED_SHARED);
  });

  it('云账号一律留在自己的区域目录，绝不进共享根', () => {
    expect(resolveOwnerDataRootDir(CLOUD_OWNER_ID, CN_DIR)).toBe(CN_DIR);
    expect(resolveOwnerDataRootDir(CLOUD_OWNER_ID, GLOBAL_DIR)).toBe(GLOBAL_DIR);
  });

  it('owner 未确定（null / undefined / 空串）时保持区域目录', () => {
    expect(resolveOwnerDataRootDir(null, CN_DIR)).toBe(CN_DIR);
    expect(resolveOwnerDataRootDir(undefined, CN_DIR)).toBe(CN_DIR);
    expect(resolveOwnerDataRootDir('', CN_DIR)).toBe(CN_DIR);
  });

  it('隔离沙箱与自定义 userData 退化为自身，不共享', () => {
    const sandbox = path.join('/AppData/Roaming', 'Cindy-dev2');
    const namedSandbox = path.join('/AppData/Roaming', 'CindyGlobal-dev2-experiment');
    const custom = path.join('/tmp', 'my-cindy-profile');
    expect(resolveOwnerDataRootDir(LOCAL_PROFILE_DATA_OWNER_ID, sandbox)).toBe(sandbox);
    expect(resolveOwnerDataRootDir(LOCAL_PROFILE_DATA_OWNER_ID, namedSandbox)).toBe(namedSandbox);
    expect(resolveOwnerDataRootDir(LOCAL_PROFILE_DATA_OWNER_ID, custom)).toBe(custom);
  });

  it('共享根与区域目录同级，不嵌套在任何一个区域目录内', () => {
    const shared = resolveOwnerDataRootDir(LOCAL_PROFILE_DATA_OWNER_ID, CN_DIR);
    expect(path.dirname(shared)).toBe(path.dirname(CN_DIR));
    // 用 path.relative 而不是 startsWith：`CindyShared` 以 `Cindy` 开头，
    // 任何字符串前缀判断都会把共享根误判成 cn 目录的子目录。
    expect(path.relative(CN_DIR, shared).startsWith('..')).toBe(true);
    expect(path.relative(GLOBAL_DIR, shared).startsWith('..')).toBe(true);
  });
});

describe('resolveSessionDbRootDir', () => {
  it('本机会话库：所有 owner（local-v1 与云账号）在任一正式区域都解析到同一共享根', () => {
    const fromCnLocal = resolveSessionDbRootDir(LOCAL_PROFILE_DATA_OWNER_ID, CN_DIR);
    const fromGlobalLocal = resolveSessionDbRootDir(LOCAL_PROFILE_DATA_OWNER_ID, GLOBAL_DIR);
    const fromCnCloud = resolveSessionDbRootDir(CLOUD_OWNER_ID, CN_DIR);
    const fromGlobalCloud = resolveSessionDbRootDir(CLOUD_OWNER_ID, GLOBAL_DIR);
    expect(fromCnLocal).toBe(EXPECTED_SHARED);
    expect(fromGlobalLocal).toBe(EXPECTED_SHARED);
    expect(fromCnCloud).toBe(EXPECTED_SHARED);
    expect(fromGlobalCloud).toBe(EXPECTED_SHARED);
    // 特性核心：切版本后拿到的是同一份本机会话库，与登录态/账号无关。
    expect(fromCnLocal).toBe(fromGlobalCloud);
  });

  it('dev 正式目录同样共享会话库', () => {
    expect(resolveSessionDbRootDir(CLOUD_OWNER_ID, DEV_DIR)).toBe(EXPECTED_SHARED);
    expect(resolveSessionDbRootDir(LOCAL_PROFILE_DATA_OWNER_ID, DEV_DIR)).toBe(EXPECTED_SHARED);
  });

  it('会话库共享 ≠ 命名空间共享：云账号凭证仍按区域隔离，只有库文件落共享根', () => {
    // 库文件（会话数据）共享
    expect(resolveSessionDbRootDir(CLOUD_OWNER_ID, CN_DIR)).toBe(EXPECTED_SHARED);
    // 命名空间（token / model-access-credentials 等凭证）依旧留在各自区域目录
    expect(resolveOwnerDataRootDir(CLOUD_OWNER_ID, CN_DIR)).toBe(CN_DIR);
    expect(resolveOwnerDataRootDir(CLOUD_OWNER_ID, GLOBAL_DIR)).toBe(GLOBAL_DIR);
  });

  it('owner 未确定（null / undefined / 空串）时保持区域目录', () => {
    expect(resolveSessionDbRootDir(null, CN_DIR)).toBe(CN_DIR);
    expect(resolveSessionDbRootDir(undefined, CN_DIR)).toBe(CN_DIR);
    expect(resolveSessionDbRootDir('', CN_DIR)).toBe(CN_DIR);
  });

  it('隔离沙箱与自定义 userData 不共享会话库', () => {
    const sandbox = path.join('/AppData/Roaming', 'Cindy-dev2');
    const custom = path.join('/tmp', 'my-cindy-profile');
    expect(resolveSessionDbRootDir(LOCAL_PROFILE_DATA_OWNER_ID, sandbox)).toBe(sandbox);
    expect(resolveSessionDbRootDir(CLOUD_OWNER_ID, custom)).toBe(custom);
  });
});

describe('isProductionRegionUserDataDir', () => {
  it('只认三个品牌区域目录名', () => {
    expect(isProductionRegionUserDataDir(CN_DIR)).toBe(true);
    expect(isProductionRegionUserDataDir(GLOBAL_DIR)).toBe(true);
    expect(isProductionRegionUserDataDir(DEV_DIR)).toBe(true);
  });

  it('沙箱、共享根自身与自定义目录都不是正式目录', () => {
    expect(isProductionRegionUserDataDir(path.join('/AppData/Roaming', 'Cindy-dev2'))).toBe(false);
    expect(isProductionRegionUserDataDir(EXPECTED_SHARED)).toBe(false);
    expect(isProductionRegionUserDataDir('/tmp/whatever')).toBe(false);
  });
});
