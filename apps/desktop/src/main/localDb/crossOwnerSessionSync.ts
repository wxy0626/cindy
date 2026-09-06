/**
 * crossOwnerSessionSync — 本机跨账号 / 跨版本会话镜像同步（2026-09-06 用户裁决）。
 *
 * 需求：同一台机器上，无论哪个构建身份（cn / global / dev 渠道）、登录哪个账号
 * （云账号 / local-v1），侧边栏都要能看到全部本机对话——「两版本和多账号要互通」。
 *
 * 现状前提（localProfileSharedRoot.ts）：正式区域身份的会话库统一落跨区域共享根
 * （`CindyShared/cindy-<ownerId>.db`），但文件仍按 owner 切片——同机换账号后
 * `sessions:list` 只读当前 owner 的库，其它账号的对话天然不可见。
 *
 * 本模块的做法是**镜像同步**而非聚合读：
 *   - 启动 / 切账号后延迟几秒，枚举共享根（沙箱额外只读回看三个正式区域目录）里
 *     其它 owner 的 `cindy-<ownerId>.db`；
 *   - 把兄弟库的 sessions 行 + 对应 messages 行 + 消息引用的 media 行，按
 *     `updated_at` 收敛语义 upsert 进当前 owner 的库；
 *   - 删除传播：源库软删（status='deleted'）随行镜像过来，本地副本同标记；
 *   - FTS 由既有触发器（messages_fts_insert 等）自动维护，无需手工回填。
 *
 * 边界与安全：
 *   - 只碰 sessions / messages / media_blobs / media_refs 四张表；凭证
 *     （model-access-credentials、secret store）与其它 owner 命名空间数据一律不读
 *     不写（authManager 安全红线不动）。
 *   - 兄弟库一律 **readonly** 连接，任何失败只记日志不影响本库。
 *   - 沙箱（非正式区域目录）对正式数据**只进不出**：允许读正式目录镜像进来，
 *     绝不把沙箱数据同步出去（隔离测试永不写脏用户真实数据）。
 */

import fs from 'node:fs';
import path from 'node:path';

import type Database from 'better-sqlite3';

import { BRAND_IDENTITY } from '@cindy/maker-shared/brand-identity';

import {
  isProductionRegionUserDataDir,
  LOCAL_PROFILE_SHARED_DIR_NAME,
} from '../localProfileSharedRoot.js';
import { createBetterSqliteDatabase } from './betterSqliteFactory.js';
import { createLogger } from '../logger.js';

const log = createLogger('cross-owner-session-sync');

const SIBLING_FILE_PATTERN = /^cindy-(.+)\.db$/;
const BUSY_TIMEOUT_MS = 3_000;
const STARTUP_DELAY_MS = 3_000;
const MIN_RUN_INTERVAL_MS = 60_000;

export interface CrossOwnerSyncDeps {
  /** 当前 owner 已就绪的主库连接（ensureReady 打开的那份）。 */
  db: Database.Database;
  currentUserId: string;
  currentDbPath: string | null;
  userDataDir: string;
}

export interface CrossOwnerSyncSummary {
  siblings: number;
  sessionsUpserted: number;
  messagesCopied: number;
  failed: Array<{ path: string; reason: string }>;
}

export interface SiblingDiscovery {
  paths: string[];
  skippedCurrentOwner: number;
}

/** 最后一次运行时间（含沙箱内多账号快速切换的节流）。 */
let lastRunStartedAt = 0;
let inFlight = false;

/**
 * 启动 / 切账号后调度一次镜像同步。节流：60s 内不重复跑；in-flight 不重入。
 * fire-and-forget：任何失败只记日志，绝不影响 ensureReady 主流程。
 */
export function scheduleCrossOwnerSessionSync(deps: CrossOwnerSyncDeps): void {
  if (inFlight) return;
  const now = Date.now();
  if (now - lastRunStartedAt < MIN_RUN_INTERVAL_MS) return;
  inFlight = true;
  lastRunStartedAt = now;
  const timer = setTimeout(() => {
    void runCrossOwnerSessionSync(deps)
      .catch((error) => {
        log.warn('cross-owner session sync failed (non-fatal)', {
          error: error instanceof Error ? error.message : String(error),
        });
      })
      .finally(() => {
        inFlight = false;
      });
  }, STARTUP_DELAY_MS);
  // 不持有事件循环——应用退出时无需等同步。
  timer.unref?.();
}

/**
 * 枚举候选目录：
 *   - 正式区域身份：共享根（当前库所在目录，seeder 已保证全部 owner 库都在）；
 *   - 沙箱 / 自定义 userData：额外只读回看三个正式区域目录与共享根（只进不出）。
 */
function candidateDirs(userDataDir: string, currentDbPath: string | null): string[] {
  const dirs = new Set<string>();
  if (currentDbPath) dirs.add(path.dirname(currentDbPath));
  if (!isProductionRegionUserDataDir(userDataDir)) {
    const base = path.dirname(userDataDir);
    for (const dirName of Object.values(BRAND_IDENTITY.userDataDirNameByRegion)) {
      dirs.add(path.join(base, dirName));
      dirs.add(path.join(base, LOCAL_PROFILE_SHARED_DIR_NAME));
    }
  }
  return [...dirs];
}

/** 枚举其它 owner 的库文件（排除当前 owner 自身与备份 / 迁移产物）。 */
export function discoverSiblingOwnerDbPaths(
  userDataDir: string,
  currentDbPath: string | null,
  currentUserId: string,
): SiblingDiscovery {
  const paths: string[] = [];
  const seenReal = new Set<string>();
  let skippedCurrentOwner = 0;
  const ownReal = safeRealpath(currentDbPath);
  if (ownReal) seenReal.add(ownReal);

  for (const dir of candidateDirs(userDataDir, currentDbPath)) {
    let entries: string[];
    try {
      entries = fs.readdirSync(dir);
    } catch {
      continue;
    }
    for (const name of entries) {
      const match = SIBLING_FILE_PATTERN.exec(name);
      if (!match) continue;
      const ownerId = match[1];
      // 备份产物形如 `cindy-<owner>.db.bak.<ts>`（不满足 ^...\.db$）不会进到这里；
      // owner id 本身不该含点，含点视为异常文件跳过。
      if (ownerId.includes('.')) continue;
      if (ownerId === currentUserId) {
        skippedCurrentOwner += 1;
        continue;
      }
      const full = path.join(dir, name);
      const real = safeRealpath(full);
      const key = real ?? full;
      if (real && ownReal && real === ownReal) continue;
      if (seenReal.has(key)) continue;
      seenReal.add(key);
      paths.push(full);
    }
  }
  return { paths, skippedCurrentOwner };
}

function safeRealpath(p: string | null): string | null {
  if (!p) return null;
  try {
    return fs.realpathSync(p);
  } catch {
    return null;
  }
}

function quoteIdent(name: string): string {
  return `"${name.replaceAll('"', '""')}"`;
}

/** sessions：整行收敛——仅当源行比本地行新（updated_at 更大）才整行覆盖。 */
function buildSessionUpsertSql(cols: string[]): string {
  const colList = cols.map(quoteIdent).join(', ');
  const placeholders = cols.map((c) => `@${c}`).join(', ');
  const updates = cols
    .filter((c) => c !== 'id')
    .map((c) => `${quoteIdent(c)} = excluded.${quoteIdent(c)}`)
    .join(', ');
  return `INSERT INTO sessions (${colList}) VALUES (${placeholders}) ON CONFLICT(id) DO UPDATE SET ${updates} WHERE excluded.updated_at > sessions.updated_at`;
}

/**
 * messages：追加为主，冲突（同 id）时收敛可变列——rewind_at（rewind 截断）、
 * content / agent_meta（message_tombstone 清空传播）。顺序保证：sessions 先行，
 * messages 的 FK（session_id → sessions.id, cascade）才能成立。
 */
function buildMessageUpsertSql(cols: string[]): string {
  const colList = cols.map(quoteIdent).join(', ');
  const placeholders = cols.map((c) => `@${c}`).join(', ');
  const mutable = cols.filter((c) => ['rewind_at', 'content', 'agent_meta'].includes(c));
  const updates = mutable
    .map((c) => `${quoteIdent(c)} = excluded.${quoteIdent(c)}`)
    .join(', ');
  const conflictClause = updates
    ? ` ON CONFLICT(id) DO UPDATE SET ${updates}`
    : ' ON CONFLICT(id) DO NOTHING';
  return `INSERT INTO messages (${colList}) VALUES (${placeholders})${conflictClause}`;
}

function tableColumns(db: Database.Database, table: string): string[] {
  return (db.pragma(`table_info(${quoteIdent(table)})`) as Array<{ name: string }>).map(
    (row) => row.name,
  );
}

function hasTable(db: Database.Database, table: string): boolean {
  const row = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(table) as { name: string } | undefined;
  return !!row;
}

async function runCrossOwnerSessionSync(deps: CrossOwnerSyncDeps): Promise<CrossOwnerSyncSummary> {
  const startedAt = Date.now();
  const { paths } = discoverSiblingOwnerDbPaths(
    deps.userDataDir,
    deps.currentDbPath,
    deps.currentUserId,
  );
  const summary: CrossOwnerSyncSummary = {
    siblings: paths.length,
    sessionsUpserted: 0,
    messagesCopied: 0,
    failed: [],
  };
  if (paths.length === 0) {
    log.info('cross-owner session sync: no sibling dbs', { userId: deps.currentUserId });
    return summary;
  }
  // 多连接（worker / utility transport 与本连接）并发写同一 WAL 库是常态，
  // 写前给当前连接一个 busy timeout，避免偶发 SQLITE_BUSY 直接失败。
  deps.db.pragma(`busy_timeout = ${BUSY_TIMEOUT_MS}`);
  for (const siblingPath of paths) {
    try {
      const result = syncOneSibling(deps.db, siblingPath);
      summary.sessionsUpserted += result.sessionsUpserted;
      summary.messagesCopied += result.messagesCopied;
    } catch (error) {
      summary.failed.push({
        path: siblingPath,
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }
  log.info('cross-owner session sync complete', {
    userId: deps.currentUserId,
    siblings: summary.siblings,
    sessionsUpserted: summary.sessionsUpserted,
    messagesCopied: summary.messagesCopied,
    failed: summary.failed.length,
    elapsedMs: Date.now() - startedAt,
  });
  return summary;
}

/**
 * 立即执行一次镜像同步（测试 / 手动触发入口；调度走 scheduleCrossOwnerSessionSync）。
 */
export function syncSessionsFromSiblingDbs(
  deps: CrossOwnerSyncDeps,
): Promise<CrossOwnerSyncSummary> {
  return runCrossOwnerSessionSync(deps);
}

function syncOneSibling(
  db: Database.Database,
  siblingPath: string,
): { sessionsUpserted: number; messagesCopied: number } {
  let sessionsUpserted = 0;
  let messagesCopied = 0;
  const sibling = createBetterSqliteDatabase(siblingPath, { readonly: true, fileMustExist: true });
  try {
    if (!hasTable(sibling, 'sessions')) return { sessionsUpserted: 0, messagesCopied: 0 };
    const sessionRows = sibling.prepare('SELECT * FROM sessions').all() as Array<
      Record<string, unknown>
    >;
    if (sessionRows.length === 0) return { sessionsUpserted: 0, messagesCopied: 0 };

    const sessionCols = tableColumns(sibling, 'sessions');
    const messageCols = hasTable(sibling, 'messages') ? tableColumns(sibling, 'messages') : [];
    const localSessionCols = tableColumns(db, 'sessions');
    const localMessageCols = hasTable(db, 'messages') ? tableColumns(db, 'messages') : [];
    // 两库 schema 版本可能不同（旧兄弟库缺新列）——只拷两边共有的列。
    const usableSessionCols = sessionCols.filter((c) => localSessionCols.includes(c));
    const usableMessageCols = messageCols.filter((c) => localMessageCols.includes(c));
    const sessionInsert = db.prepare(buildSessionUpsertSql(usableSessionCols));
    const messageInsert =
      usableMessageCols.length > 0 && hasTable(db, 'messages')
        ? db.prepare(buildMessageUpsertSql(usableMessageCols))
        : null;
    const siblingMessages = messageInsert
      ? sibling.prepare('SELECT * FROM messages WHERE session_id = ?')
      : null;

    const writeAll = db.transaction(() => {
      const sessionIds: string[] = [];
      for (const row of sessionRows) {
        const params: Record<string, unknown> = {};
        for (const col of usableSessionCols) params[col] = row[col];
        const result = sessionInsert.run(params);
        sessionsUpserted += result.changes > 0 ? 1 : 0;
        sessionIds.push(String(row.id));
      }
      if (!messageInsert || !siblingMessages) return;
      for (const sessionId of sessionIds) {
        const rows = siblingMessages.all(sessionId) as Array<Record<string, unknown>>;
        for (const row of rows) {
          const params: Record<string, unknown> = {};
          for (const col of usableMessageCols) params[col] = row[col];
          const result = messageInsert.run(params);
          messagesCopied += result.changes;
        }
      }
      copySessionMedia(db, sibling, sessionIds);
    });
    writeAll();
    return { sessionsUpserted, messagesCopied };
  } finally {
    sibling.close();
  }
}

/**
 * 消息里引用的图片等媒体：media_refs（按 origin_session_id 定位）与
 * media_blobs（内容寻址 hash）一并 INSERT OR IGNORE——两表都是幂等键，
 * 已存在即跳过，不做更新。
 */
function copySessionMedia(
  db: Database.Database,
  sibling: Database.Database,
  sessionIds: string[],
): void {
  if (sessionIds.length === 0) return;
  if (!hasTable(sibling, 'media_refs') || !hasTable(db, 'media_refs')) return;
  const placeholders = sessionIds.map(() => '?').join(', ');
  const refRows = sibling
    .prepare(`SELECT * FROM media_refs WHERE origin_session_id IN (${placeholders})`)
    .all(...sessionIds) as Array<Record<string, unknown>>;
  if (refRows.length === 0) return;
  const refCols = tableColumns(sibling, 'media_refs').filter((c) =>
    tableColumns(db, 'media_refs').includes(c),
  );
  const refInsert = db.prepare(
    `INSERT OR IGNORE INTO media_refs (${refCols.map(quoteIdent).join(', ')}) VALUES (${refCols
      .map((c) => `@${c}`)
      .join(', ')})`,
  );
  const hashes = [...new Set(refRows.map((r) => String(r.hash)).filter(Boolean))];
  for (const row of refRows) {
    const params: Record<string, unknown> = {};
    for (const col of refCols) params[col] = row[col];
    refInsert.run(params);
  }
  if (hashes.length > 0 && hasTable(sibling, 'media_blobs') && hasTable(db, 'media_blobs')) {
    const blobCols = tableColumns(sibling, 'media_blobs').filter((c) =>
      tableColumns(db, 'media_blobs').includes(c),
    );
    const blobInsert = db.prepare(
      `INSERT OR IGNORE INTO media_blobs (${blobCols
        .map(quoteIdent)
        .join(', ')}) VALUES (${blobCols.map((c) => `@${c}`).join(', ')})`,
    );
    const blobSelect = sibling.prepare('SELECT * FROM media_blobs WHERE hash = ?');
    for (const hash of hashes) {
      const blob = blobSelect.get(hash) as Record<string, unknown> | undefined;
      if (!blob) continue;
      const params: Record<string, unknown> = {};
      for (const col of blobCols) params[col] = blob[col];
      blobInsert.run(params);
    }
  }
}
