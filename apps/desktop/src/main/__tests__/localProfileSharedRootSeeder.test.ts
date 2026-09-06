/**
 * localProfileSharedRootSeeder 的语义契约。
 *
 * 锁住三条数据安全边界：
 *   1. 多个区域目录都有同一 owner 的库时，按 cn → global → dev 顺序**先到先得**，
 *      后到的绝不覆盖已播种的数据；
 *   2. **只复制、不移动、不删除**源文件——共享根即使被破坏，旧数据仍在原地可抢救；
 *   3. 共享根已有主库时幂等跳过，重启不重复、不覆盖。
 *
 * 泛化后（seedSessionDbSharedRoot）额外锁住：
 *   4. 所有 owner（云账号 + local-v1 免登录档案）的会话库都被播种，只要本机出现过；
 *   5. 凭证命名空间仍按区域隔离——seeder 只搬库文件，绝不碰 token / credentials。
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  seedLocalProfileSharedRoot,
  seedSessionDbSharedRoot,
} from '../localProfileSharedRootSeeder.js';
import { LOCAL_PROFILE_DATA_OWNER_ID } from '../profile/profileRegistryModel.js';
import { brandUserDataDirName } from '@cindy/maker-shared/brand-identity';

const ROOT_DIRS = new Set<string>();

async function makeRegionRoot(regionName: string): Promise<string> {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), `cindy-seeder-${regionName}-`));
  ROOT_DIRS.add(root);
  return root;
}

afterEach(async () => {
  await Promise.all([...ROOT_DIRS].map((r) => fs.promises.rm(r, { recursive: true, force: true })));
  ROOT_DIRS.clear();
});

/** 构造 appData 基址 + cn/global 两个区域目录，返回 {appData, cnDir, globalDir}。 */
async function makeAppDataLayout(): Promise<{
  appData: string;
  cnDir: string;
  globalDir: string;
}> {
  const appData = await makeRegionRoot('appdata');
  const cnDir = path.join(appData, brandUserDataDirName('cn'));
  const globalDir = path.join(appData, brandUserDataDirName('global'));
  await fs.promises.mkdir(cnDir, { recursive: true });
  await fs.promises.mkdir(globalDir, { recursive: true });
  return { appData, cnDir, globalDir };
}

const LOCAL_DB_NAME = `${'cindy'}-${LOCAL_PROFILE_DATA_OWNER_ID}.db`;
const LOCAL_DB_WAL = `${LOCAL_DB_NAME}-wal`;
const LOCAL_MARKER = `${'cindy'}-${LOCAL_PROFILE_DATA_OWNER_ID}.local-profile-migration.json`;

describe('seedLocalProfileSharedRoot', () => {
  it('从 global 区域把 local-v1 文件组播种进共享根，源文件保留', async () => {
    const { appData, globalDir } = await makeAppDataLayout();
    const sourceDb = path.join(globalDir, LOCAL_DB_NAME);
    const sourceWal = path.join(globalDir, LOCAL_DB_WAL);
    const sourceMarker = path.join(globalDir, LOCAL_MARKER);
    await fs.promises.writeFile(sourceDb, 'fake-db-bytes');
    await fs.promises.writeFile(sourceWal, 'fake-wal-bytes');
    await fs.promises.writeFile(sourceMarker, '{"ownerId":"owner-a"}\n');

    const seeded = seedLocalProfileSharedRoot(globalDir, 'cindy');
    expect(seeded).toBe(true);

    const sharedRoot = path.join(appData, 'CindyShared');
    expect(fs.existsSync(path.join(sharedRoot, LOCAL_DB_NAME))).toBe(true);
    expect(fs.existsSync(path.join(sharedRoot, LOCAL_DB_WAL))).toBe(true);
    expect(fs.existsSync(path.join(sharedRoot, LOCAL_MARKER))).toBe(true);
    // 源文件保留
    expect(fs.existsSync(sourceDb)).toBe(true);
    expect(fs.existsSync(sourceWal)).toBe(true);
  });

  it('共享根已有主库时幂等跳过，不重复播种', async () => {
    const { appData, globalDir, cnDir } = await makeAppDataLayout();
    const sharedRoot = path.join(appData, 'CindyShared');
    await fs.promises.mkdir(sharedRoot, { recursive: true });
    // 共享根里已有一个不同内容的库（模拟新版本已正常写入）
    await fs.promises.writeFile(path.join(sharedRoot, LOCAL_DB_NAME), 'newer-data');

    // global 和 cn 都有旧库，但共享根已有主库 → 跳过
    await fs.promises.writeFile(path.join(globalDir, LOCAL_DB_NAME), 'global-old');
    await fs.promises.writeFile(path.join(cnDir, LOCAL_DB_NAME), 'cn-old');

    const seeded = seedLocalProfileSharedRoot(globalDir, 'cindy');
    expect(seeded).toBe(false);
    expect(fs.readFileSync(path.join(sharedRoot, LOCAL_DB_NAME), 'utf8')).toBe('newer-data');
  });

  it('多个区域都有旧库时先到先得：cn 优先于 global', async () => {
    const { appData, cnDir, globalDir } = await makeAppDataLayout();
    await fs.promises.writeFile(path.join(cnDir, LOCAL_DB_NAME), 'cn-data');
    await fs.promises.writeFile(path.join(globalDir, LOCAL_DB_NAME), 'global-data');

    const seeded = seedLocalProfileSharedRoot(globalDir, 'cindy');
    expect(seeded).toBe(true);
    const sharedDb = path.join(appData, 'CindyShared', LOCAL_DB_NAME);
    expect(fs.readFileSync(sharedDb, 'utf8')).toBe('cn-data');
  });

  it('源侧无 local-v1 库时不播种', async () => {
    const { appData, globalDir } = await makeAppDataLayout();
    const seeded = seedLocalProfileSharedRoot(globalDir, 'cindy');
    expect(seeded).toBe(false);
    expect(fs.existsSync(path.join(appData, 'CindyShared'))).toBe(false);
  });

  it('非正式区域目录（沙箱）不播种', async () => {
    const sandboxRoot = await makeRegionRoot('sandbox');
    const sandboxDir = path.join(sandboxRoot, 'Cindy-dev2');
    await fs.promises.mkdir(sandboxDir, { recursive: true });
    const seeded = seedLocalProfileSharedRoot(sandboxDir, 'cindy');
    expect(seeded).toBe(false);
    // 沙箱自身不产生共享根
    expect(fs.existsSync(path.join(sandboxRoot, 'CindyShared'))).toBe(false);
  });
});

describe('seedSessionDbSharedRoot（本机会话全共享）', () => {
  const CLOUD_OWNER_CN = 'cmtl7ysug2kisw1016fhxrqi1';
  const CLOUD_OWNER_GLOBAL = 'cmtjzeskv0bxszb01mucp0jlp';

  it('播种所有 owner 的库：云账号（cn/global 各一）+ local-v1 全部进共享根', async () => {
    const { appData, cnDir, globalDir } = await makeAppDataLayout();
    const cnCloudDb = path.join(cnDir, `cindy-${CLOUD_OWNER_CN}.db`);
    const globalCloudDb = path.join(globalDir, `cindy-${CLOUD_OWNER_GLOBAL}.db`);
    const localDb = path.join(globalDir, LOCAL_DB_NAME);
    await fs.promises.writeFile(cnCloudDb, 'cn-cloud-data');
    await fs.promises.writeFile(globalCloudDb, 'global-cloud-data');
    await fs.promises.writeFile(localDb, 'local-data');

    const seeded = seedSessionDbSharedRoot(globalDir, 'cindy');
    expect(seeded).toBe(true);

    const sharedRoot = path.join(appData, 'CindyShared');
    expect(fs.readFileSync(path.join(sharedRoot, `cindy-${CLOUD_OWNER_CN}.db`), 'utf8')).toBe(
      'cn-cloud-data',
    );
    expect(fs.readFileSync(path.join(sharedRoot, `cindy-${CLOUD_OWNER_GLOBAL}.db`), 'utf8')).toBe(
      'global-cloud-data',
    );
    expect(fs.readFileSync(path.join(sharedRoot, LOCAL_DB_NAME), 'utf8')).toBe('local-data');
    // 源文件全部保留
    expect(fs.existsSync(cnCloudDb)).toBe(true);
    expect(fs.existsSync(globalCloudDb)).toBe(true);
    expect(fs.existsSync(localDb)).toBe(true);
  });

  it('同一 owner 在多个区域都有库时先到先得，每个 owner 独立判定', async () => {
    const { appData, cnDir, globalDir } = await makeAppDataLayout();
    // cn 的云库与 local-v1，global 只有云库
    await fs.promises.writeFile(path.join(cnDir, `cindy-${CLOUD_OWNER_CN}.db`), 'cn-cloud');
    await fs.promises.writeFile(path.join(globalDir, `cindy-${CLOUD_OWNER_CN}.db`), 'global-cloud');
    await fs.promises.writeFile(path.join(cnDir, LOCAL_DB_NAME), 'cn-local');

    const seeded = seedSessionDbSharedRoot(globalDir, 'cindy');
    expect(seeded).toBe(true);

    const sharedRoot = path.join(appData, 'CindyShared');
    // 云库：cn 先到（cn 优先于 global）
    expect(fs.readFileSync(path.join(sharedRoot, `cindy-${CLOUD_OWNER_CN}.db`), 'utf8')).toBe(
      'cn-cloud',
    );
    // local-v1：只有 cn 有 → 从 cn 搬
    expect(fs.readFileSync(path.join(sharedRoot, LOCAL_DB_NAME), 'utf8')).toBe('cn-local');
  });

  it('共享根已有某 owner 主库时，该 owner 幂等跳过但其它 owner 照常播种', async () => {
    const { appData, cnDir, globalDir } = await makeAppDataLayout();
    const sharedRoot = path.join(appData, 'CindyShared');
    await fs.promises.mkdir(sharedRoot, { recursive: true });
    // 共享根已有云库（新版本已写入），local-v1 还没搬
    await fs.promises.writeFile(path.join(sharedRoot, `cindy-${CLOUD_OWNER_CN}.db`), 'newer');
    await fs.promises.writeFile(path.join(cnDir, `cindy-${CLOUD_OWNER_CN}.db`), 'old-cn');
    await fs.promises.writeFile(path.join(cnDir, LOCAL_DB_NAME), 'cn-local');

    const seeded = seedSessionDbSharedRoot(globalDir, 'cindy');
    expect(seeded).toBe(true);
    // 云库不被覆盖
    expect(fs.readFileSync(path.join(sharedRoot, `cindy-${CLOUD_OWNER_CN}.db`), 'utf8')).toBe(
      'newer',
    );
    // local-v1 照常搬
    expect(fs.readFileSync(path.join(sharedRoot, LOCAL_DB_NAME), 'utf8')).toBe('cn-local');
  });

  it('源侧完全没有库时不播种', async () => {
    const { appData, globalDir } = await makeAppDataLayout();
    const seeded = seedSessionDbSharedRoot(globalDir, 'cindy');
    expect(seeded).toBe(false);
    expect(fs.existsSync(path.join(appData, 'CindyShared'))).toBe(false);
  });

  it('非正式区域目录（沙箱）不播种', async () => {
    const sandboxRoot = await makeRegionRoot('sandbox');
    const sandboxDir = path.join(sandboxRoot, 'Cindy-dev2');
    await fs.promises.mkdir(sandboxDir, { recursive: true });
    // 沙箱里哪怕有库文件也不播种（隔离实例不碰真实共享数据）
    await fs.promises.writeFile(path.join(sandboxDir, LOCAL_DB_NAME), 'sandbox-data');
    const seeded = seedSessionDbSharedRoot(sandboxDir, 'cindy');
    expect(seeded).toBe(false);
    expect(fs.existsSync(path.join(sandboxRoot, 'CindyShared'))).toBe(false);
  });

  it('只搬库文件，绝不碰凭证命名空间文件', async () => {
    const { appData, cnDir } = await makeAppDataLayout();
    await fs.promises.writeFile(path.join(cnDir, `cindy-${CLOUD_OWNER_CN}.db`), 'cn-cloud');
    // 凭证文件（模拟 token 命名空间内容）留在区域目录
    const credentialPath = path.join(cnDir, 'token.json');
    await fs.promises.writeFile(credentialPath, '{"accessToken":"secret"}');

    const seeded = seedSessionDbSharedRoot(cnDir, 'cindy');
    expect(seeded).toBe(true);

    const sharedRoot = path.join(appData, 'CindyShared');
    expect(fs.existsSync(path.join(sharedRoot, 'token.json'))).toBe(false);
    // 凭证原样留在区域目录
    expect(fs.readFileSync(credentialPath, 'utf8')).toBe('{"accessToken":"secret"}');
  });
});
