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
 *   - 正式区域与 dev 沙箱**双向互通**（2026-09-06 用户裁决：版本+账号全互通、
 *     本机对话都进左侧列表，dev 开发期就能验证，不只在正式版）。
 */

import fs from 'node:fs';
import path from 'node:path';

import type Database from 'better-sqlite3';

import { BRAND_IDENTITY } from '@cindy/maker-shared/brand-identity';

import { LOCAL_PROFILE_SHARED_DIR_NAME } from '../localProfileSharedRoot.js';
import { createBetterSqliteDatabase } from './betterSqliteFactory.js';
import { loadSqliteVec } from './sqliteVecLoader.js';
import { createLogger } from '../logger.js';
import { emitSessionCreated } from './ipc/sessionCreatedBroadcast.js';
import type { LocalProjectSyncOptions } from '../../shared/localProjectSync.js';
import { stableLocalProjectSyncId } from '../localProjectSync.js';

const log = createLogger('cross-owner-session-sync');

const SIBLING_FILE_PATTERN = /^cindy-(.+)\.db$/;
const BUSY_TIMEOUT_MS = 3_000;
const LEGACY_MIRROR_METADATA_COLUMNS = [
  'id',
  'title',
  'created_at',
  'workspace_kind',
  'working_dir',
  'remote_host_id',
] as const;
const SENSITIVE_SESSION_COLUMNS = new Set([
  'sdk_session_id',
  'provider_id',
  'worktree_path',
  'feishu_open_id',
  'feishu_bot_app_id',
  'im_bot_context_id',
  'im_user_id',
  'codex_history_has_product_prompt',
  'codex_plan_json',
  'extra_dirs',
  'writable_dirs',
  'remote_host_id',
  'active_turn_started_at',
  'active_turn_pid',
  'last_turn_ended_at',
]);
const SENSITIVE_MESSAGE_COLUMNS = new Set(['tool_use_id', 'agent_meta']);
// 冷启动常先以 signed-out/local-v1 或某个云 owner 就绪，随后用户登录才切到真正
// 的云 owner。若在 60s 内靠节流挡掉「登录后的那次调度」，用户登录后就不会有对话
// 互通。故**不按时间节流**，只靠 in-flight 防重入：每次 ensureReady 成功都调度，
// 正在跑就等下次（登录 / 切账号会再次 ensureReady）。不按时间节流只靠
// in-flight 防重入，让冷启动后的登录切换也有机会跑一次。

export interface CrossOwnerSyncDeps {
  /**
   * 目标 owner 与其库路径——**常量捕获**（2026-09-06 最终修复）。
   * worker-thread 架构下主进程的 _currentUserId/_currentDbPath 是瞬态变量：
   * ensureReady 迁移窗口结束即被 dbClientTakeover/closeDb 清空，getter 永远拿
   * 不到（23:03 日志铁证：ensureReady.ok 3 秒后 getter 全 null，重试 4 次耗尽）。
   * schedule 本就在 ensureReady 作用域内，直接捕获 userId/dbPath 字符串常量，
   * 没有时序风险；同步用自开短生命周期 WAL 连接写库，与 worker 并发安全。
   */
  userId: string;
  dbPath: string;
  userDataDir: string;
  /** 当前登录确认的本机共享策略；null 表示明确关闭全部共享。 */
  localProjectSync?: LocalProjectSyncOptions | null;
  /**
   * 可选：调用方已有的打开连接（单测注入用）。缺省或已关闭时同步自开连接。
   */
  getDb?: () => Database.Database | null;
}

export interface CrossOwnerSyncSummary {
  siblings: number;
  sessionsUpserted: number;
  messagesCopied: number;
  failed: Array<{ path: string; reason: string }>;
}

/** 同步完成后通知 Renderer 重拉本机会话列表，避免数据库已更新但侧栏仍停留在旧快照。 */
function notifySyncedSessions(sessionIds: readonly string[]): void {
  for (const sessionId of sessionIds) {
    if (!sessionId) continue;
    emitSessionCreated(sessionId);
  }
}

export interface SiblingDiscovery {
  paths: string[];
  skippedCurrentOwner: number;
}

/**
 * 登录 / 切换账号后执行一次本机同步；调用方应等待它完成后再让 Renderer 读取列表。
 * 不使用后台轮询：新一轮同步只在下一次登录或切换账号时触发。
 */
export async function syncLocalSessionsOnce(deps: CrossOwnerSyncDeps): Promise<void> {
  log.info('cross-owner session sync disabled: single shared conversation database is active');
  return;
}

/**
 * 枚举候选目录（本机单一会话视图，2026-09-06 用户裁决「版本+账号全互通、本机
 * 对话都进左侧列表」）：
 *   - 当前库所在目录（通常是共享根；正式区域 seeder 已保证全部 owner 库在）；
 *   - 共享根（CindyShared）——跨区域同机对话的家；
 *   - 所有品牌区域目录（cn / global / dev 正式渠道）——兼容老版本把库留在区域
 *     目录、尚未被 seeder 播种进共享根的情况；
 *   - 沙箱目录（<品牌目录>-dev2[-name]）：统一按目录名命中「品牌区域目录 +
 *     -dev2[-*]」形状扫描，让 dev 开发沙箱也能与正式区域双向互通——否则开发期
 *     数据进不了正式版，互通只能在正式版上验证（用户 2026-09-06 明确不接受）。
 *
 * 只排除**当前正在写的那个库**（realpath 比对），其它全部当作兄弟只读镜像。
 * 不写脏其它目录：兄弟库一律 readonly 连接。
 */
function candidateDirs(userDataDir: string, currentDbPath: string | null): string[] {
  const dirs = new Set<string>();
  const base = path.dirname(userDataDir);
  // 共享根（所有区域身份的会话库共同家园）。
  dirs.add(path.join(base, LOCAL_PROFILE_SHARED_DIR_NAME));
  // 品牌区域正式目录 + 它们的 dev 沙箱（-dev2 / -dev2-<name>）。
  const regionNames = Object.values(BRAND_IDENTITY.userDataDirNameByRegion);
  for (const name of regionNames) {
    dirs.add(path.join(base, name));
  }
  // 扫一遍 appData 下以任意品牌目录名开头的沙箱目录（eg. CindyGlobal-dev2-dev）。
  try {
    for (const entry of fs.readdirSync(base)) {
      for (const name of regionNames) {
        if (entry === name) continue;
        if (entry.startsWith(`${name}-dev2`)) dirs.add(path.join(base, entry));
      }
    }
  } catch {
    // appData 读不到时静默——共享根 + 区域目录已覆盖主要路径。
  }
  // 当前库所在目录优先补上（未命中上述任何规则的自定义 userData）。
  if (currentDbPath) dirs.add(path.dirname(currentDbPath));
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
      const full = path.join(dir, name);
      const real = safeRealpath(full);
      const key = real ?? full;
      // 跨区域/跨版本可能存在同一 owner 的多个物理库；只排除当前实际打开的库。
      if (real && ownReal && real === ownReal) {
        skippedCurrentOwner += 1;
        continue;
      }
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

function siblingOwnerId(siblingPath: string): string | null {
  const match = SIBLING_FILE_PATTERN.exec(path.basename(siblingPath));
  return match?.[1] ?? null;
}

function sessionKind(row: Record<string, unknown>): 'project' | 'dialogue' | null {
  if (row.remote_host_id != null && String(row.remote_host_id).trim() !== '') return null;
  if (row.workspace_kind === 'project') return 'project';
  if (row.workspace_kind === 'dialogue') return 'dialogue';
  // 旧版本没有 workspace_kind：本地项目会话仍保留 working_dir，按此恢复类别。
  if (row.working_dir != null && String(row.working_dir).trim() !== '') return 'project';
  if ('workspace_kind' in row) return null;
  return 'dialogue';
}

function isSessionAllowed(
  row: Record<string, unknown>,
  policy: LocalProjectSyncOptions | null | undefined,
): boolean {
  if (!policy) return true;
  const kind = sessionKind(row);
  if (kind === 'project') return policy.projectConversation;
  if (kind === 'dialogue') return policy.independentConversations;
  return false;
}

function stableMappedId(sourceOwnerId: string, kind: string, id: unknown): string {
  return stableLocalProjectSyncId(sourceOwnerId, kind, String(id));
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
  const updates = mutable.map((c) => `${quoteIdent(c)} = excluded.${quoteIdent(c)}`).join(', ');
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

async function runCrossOwnerSessionSync(
  deps: CrossOwnerSyncDeps,
): Promise<CrossOwnerSyncSummary & { ownerNotReady?: boolean }> {
  const startedAt = Date.now();
  const currentUserId = deps.userId;
  const currentDbPath = deps.dbPath;
  if (!currentUserId || !currentDbPath || !deps.userDataDir) {
    // 常量缺参（理论不可达：schedule 必传）——保留防御分支。
    log.info('cross-owner session sync skipped: owner not ready at run time');
    return { siblings: 0, sessionsUpserted: 0, messagesCopied: 0, failed: [], ownerNotReady: true };
  }
  // 自持短生命周期写连接（2026-09-06 修复「connection is not open」根因）：
  // worker-thread 架构下主进程的 _db 只是迁移期临时句柄，ensureReady 完成后会被
  // dbClientTakeover 释放，拿它当写句柄必然失败。WAL 支持多连接并发，这里自己
  // 打开当前库、跑完即关，与 worker 侧连接安全共存。
  let db = deps.getDb?.() ?? null;
  let owned = false;
  if (!db || !db.open) {
    db = createBetterSqliteDatabase(currentDbPath, { fileMustExist: true });
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    // 自开连接走不到 ensureReady 的 worker 加载路径——本地 schema 含 sqlite-vec
    // vec0 虚表与维护 trigger，不加载扩展会让写 messages 等触发 vec0 的语句抛
    // "no such module: vec0"（2026-09-07 实证：5 个兄弟库全 failed）。加载本身
    // 幂等且非 fatal（loadSqliteVec 内部捕获失败只返回结果）。
    const vecLoad = loadSqliteVec(db);
    if (!vecLoad.loaded) {
      log.warn('cross-owner session sync: sqlite-vec load failed on local connection', {
        error: vecLoad.error,
        expectedPath: vecLoad.expectedPath,
      });
    }
    owned = true;
  }
  try {
    const { paths } = discoverSiblingOwnerDbPaths(deps.userDataDir, currentDbPath, currentUserId);

    // 明确的登录策略先作用于当前库，避免旧镜像在本次登录后继续显示。
    if (deps.localProjectSync !== undefined) {
      const removedSessionIds = purgeSharedSessionRows(db, deps.localProjectSync);
      if (removedSessionIds.length > 0) notifySyncedSessions(removedSessionIds);
      if (isLocalProjectSyncDisabled(deps.localProjectSync)) {
        const legacyRemoved = hasDesktopSessionRows(db)
          ? purgeLegacyDesktopMirrorRows(db, paths)
          : [];
        if (legacyRemoved.length > 0) notifySyncedSessions(legacyRemoved);
        log.info('local session sync disabled: purged existing shared sessions', {
          userId: currentUserId,
          removed: removedSessionIds.length + legacyRemoved.length,
        });
        return { siblings: 0, sessionsUpserted: 0, messagesCopied: 0, failed: [] };
      }
      if (hasDesktopSessionRows(db)) {
        const legacyRemoved = purgeLegacyDesktopMirrorRows(db, paths);
        if (legacyRemoved.length > 0) notifySyncedSessions(legacyRemoved);
      }
    }
    const summary: CrossOwnerSyncSummary = {
      siblings: paths.length,
      sessionsUpserted: 0,
      messagesCopied: 0,
      failed: [],
    };
    if (paths.length === 0) {
      log.info('cross-owner session sync: no sibling dbs', { userId: currentUserId });
      return summary;
    }
    // 多连接（worker / utility transport 与本连接）并发写同一 WAL 库是常态，
    // 写前给当前连接一个 busy timeout，避免偶发 SQLITE_BUSY 直接失败。
    db.pragma(`busy_timeout = ${BUSY_TIMEOUT_MS}`);
    for (const siblingPath of paths) {
      try {
        const result = syncOneSibling(db, siblingPath, deps.localProjectSync);
        summary.sessionsUpserted += result.sessionsUpserted;
        summary.messagesCopied += result.messagesCopied;
        // 镜像写入绕过正常 sessions IPC 写路径，必须补发统一 created 通知。
        notifySyncedSessions(result.sessionIds);
      } catch (error) {
        summary.failed.push({
          path: siblingPath,
          reason: error instanceof Error ? error.message : String(error),
        });
      }
    }
    log.info('cross-owner session sync complete', {
      userId: currentUserId,
      siblings: summary.siblings,
      sessionsUpserted: summary.sessionsUpserted,
      messagesCopied: summary.messagesCopied,
      failed: summary.failed.length,
      failedDetails: summary.failed.map(
        (f) => `${f.path.split(/[\\/]/).slice(-2).join('/')}: ${f.reason.slice(0, 160)}`,
      ),
      elapsedMs: Date.now() - startedAt,
      connection: owned ? 'owned' : 'shared',
    });
    return summary;
  } finally {
    if (owned) {
      try {
        db.close();
      } catch {
        // 关闭失败不影响主流程——进程退出时句柄随之释放。
      }
    }
  }
}

/** 关闭共享时移除历史镜像，绝不触碰当前账号自己创建的会话。 */
function purgeSharedSessionRows(
  db: Database.Database,
  policy?: LocalProjectSyncOptions | null,
): string[] {
  if (!hasTable(db, 'sessions')) return [];
  const rows = db
    // 旧版本镜像行的 status 可能为 NULL；关闭共享时必须清掉全部 shared 行，
    // 否则 NULL != 'deleted' 在 SQLite 中不会命中，侧栏仍会显示残留会话。
    .prepare("SELECT * FROM sessions WHERE source = 'shared'")
    .all() as Array<Record<string, unknown> & { id: string }>;
  const filteredRows = policy
    ? rows.filter((row) => {
        // 只清理本次策略禁止的类别，开启类别保留以支持幂等更新。
        return !isSessionAllowed(row, policy);
      })
    : rows;
  if (filteredRows.length === 0) return [];
  const ids = filteredRows.map((row) => row.id);
  const placeholders = ids.map(() => '?').join(',');
  const purge = db.transaction(() => {
    if (hasTable(db, 'media_refs')) {
      db.prepare('DELETE FROM media_refs WHERE origin_session_id IN (' + placeholders + ')').run(
        ...ids,
      );
    }
    if (hasTable(db, 'messages')) {
      db.prepare('DELETE FROM messages WHERE session_id IN (' + placeholders + ')').run(...ids);
    }
    db.prepare('DELETE FROM sessions WHERE id IN (' + placeholders + ") AND source = 'shared'").run(
      ...ids,
    );
  });
  purge();
  return ids;
}

/** 仅在当前库存在旧 desktop 行时，才允许为旧镜像兼容逻辑读取兄弟库。 */
function hasDesktopSessionRows(db: Database.Database): boolean {
  if (!hasTable(db, 'sessions')) return false;
  const row = db
    .prepare("SELECT 1 AS found FROM sessions WHERE source = 'desktop' LIMIT 1")
    .get() as { found?: number } | undefined;
  return row?.found === 1;
}

/**
 * 旧版镜像没有 source='shared' 标记。当前版本只清理能被兄弟库元数据完全证明
 * 为镜像的行，避免误删本账号正常创建的 desktop 会话。
 */
function purgeLegacyDesktopMirrorRows(
  db: Database.Database,
  siblingPaths: readonly string[],
): string[] {
  if (siblingPaths.length === 0) return [];
  const candidates = db
    .prepare("SELECT * FROM sessions WHERE source = 'desktop' AND status != 'deleted'")
    .all() as Array<Record<string, unknown>>;
  const matched: string[] = [];
  for (const candidate of candidates) {
    const isMatch = siblingPaths.some((siblingPath) => {
      let sibling: Database.Database | null = null;
      try {
        sibling = createBetterSqliteDatabase(siblingPath, {
          readonly: true,
          fileMustExist: true,
        });
        if (!hasTable(sibling, 'sessions')) return false;
        const row = sibling
          .prepare(
            `SELECT 1 AS found FROM sessions
             WHERE id = ? AND title IS ? AND created_at IS ?
               AND workspace_kind IS ? AND working_dir IS ?
               AND remote_host_id IS ? LIMIT 1`,
          )
          .get(
            candidate.id,
            candidate.title ?? null,
            candidate.created_at ?? null,
            candidate.workspace_kind ?? null,
            candidate.working_dir ?? null,
            candidate.remote_host_id ?? null,
          ) as { found?: number } | undefined;
        return row?.found === 1;
      } catch {
        return false;
      } finally {
        sibling?.close();
      }
    });
    if (isMatch) matched.push(String(candidate.id));
  }
  if (matched.length === 0) return [];
  const placeholders = matched.map(() => '?').join(',');
  db.transaction(() => {
    if (hasTable(db, 'media_refs')) {
      db.prepare(
        `DELETE FROM media_refs
         WHERE origin_session_id IN (${placeholders})
            OR (ref_kind IN ('session-attachment', 'import') AND ref_id IN (${placeholders}))`,
      ).run(...matched, ...matched);
    }
    if (hasTable(db, 'messages')) {
      db.prepare(`DELETE FROM messages WHERE session_id IN (${placeholders})`).run(...matched);
    }
    db.prepare(`DELETE FROM sessions WHERE id IN (${placeholders}) AND source = 'desktop'`).run(
      ...matched,
    );
  })();
  return matched;
}

/** 明确关闭全部六项时禁止任何跨账号扫描；未传策略的测试/内部旧入口保持兼容。 */
function isLocalProjectSyncDisabled(policy: LocalProjectSyncOptions | null | undefined): boolean {
  return policy === null || (policy !== undefined && !Object.values(policy).some(Boolean));
}

/**
 * 立即执行一次镜像同步（测试 / 手动触发入口）。
 */
export function syncSessionsFromSiblingDbs(
  deps: CrossOwnerSyncDeps,
): Promise<CrossOwnerSyncSummary> {
  return runCrossOwnerSessionSync(deps);
}

function syncOneSibling(
  db: Database.Database,
  siblingPath: string,
  localProjectSync?: LocalProjectSyncOptions | null,
): { sessionsUpserted: number; messagesCopied: number; sessionIds: string[] } {
  let sessionsUpserted = 0;
  let messagesCopied = 0;
  const sessionIds: string[] = [];
  const sibling = createBetterSqliteDatabase(siblingPath, { readonly: true, fileMustExist: true });
  try {
    // 兄弟库 schema 同样含 vec0 虚表；只读连接上也加载 sqlite-vec 扩展，
    // 避免任何读取路径触碰 vec0 时抛 "no such module: vec0"。幂等且非 fatal。
    const vecLoad = loadSqliteVec(sibling);
    if (!vecLoad.loaded) {
      log.warn('cross-owner session sync: sqlite-vec load failed on sibling connection', {
        error: vecLoad.error,
        expectedPath: vecLoad.expectedPath,
      });
    }
    if (!hasTable(sibling, 'sessions'))
      return { sessionsUpserted: 0, messagesCopied: 0, sessionIds };
    const sourceOwnerId = siblingOwnerId(siblingPath);
    if (!sourceOwnerId) {
      return { sessionsUpserted: 0, messagesCopied: 0, sessionIds };
    }
    const sessionRows = sibling.prepare('SELECT * FROM sessions').all() as Array<
      Record<string, unknown>
    >;
    const filteredSessionRows = sessionRows.filter((row) => {
      if (row.source === 'shared') return false;
      // 旧 schema 没有 workspace_kind/remote_host_id；无显式策略时保持历史兼容。
      if (localProjectSync === undefined) {
        return !('workspace_kind' in row) || sessionKind(row) !== null;
      }
      return isSessionAllowed(row, localProjectSync);
    });
    if (filteredSessionRows.length === 0)
      return { sessionsUpserted: 0, messagesCopied: 0, sessionIds };

    const sessionCols = tableColumns(sibling, 'sessions');
    const messageCols = hasTable(sibling, 'messages') ? tableColumns(sibling, 'messages') : [];
    const localSessionCols = tableColumns(db, 'sessions');
    const localMessageCols = hasTable(db, 'messages') ? tableColumns(db, 'messages') : [];
    // 两库 schema 版本可能不同（旧兄弟库缺新列）——只拷两边共有的列。
    const usableSessionCols = sessionCols.filter((c) => localSessionCols.includes(c));
    const usableMessageCols = messageCols.filter((c) => localMessageCols.includes(c));
    const useStableIds = sessionCols.includes('workspace_kind');
    const sessionInsert = db.prepare(buildSessionUpsertSql(usableSessionCols));
    const messageInsert =
      usableMessageCols.length > 0 && hasTable(db, 'messages')
        ? db.prepare(buildMessageUpsertSql(usableMessageCols))
        : null;
    const siblingMessages = messageInsert
      ? sibling.prepare('SELECT * FROM messages WHERE session_id = ?')
      : null;
    const sessionIdMap = new Map(
      filteredSessionRows.map((row) => [
        String(row.id),
        useStableIds ? stableMappedId(sourceOwnerId, 'session', row.id) : String(row.id),
      ]),
    );
    // 目标账号删除过共享镜像后，源账号仍可能保留 active 行；不能在重启时复活。
    // 源账号明确写成 deleted 时仍允许墓碑同步，保证删除传播不丢失。
    const rowsToImport = filteredSessionRows.filter((row) => {
      if (!useStableIds || row.status === 'deleted') return true;
      const mappedId = sessionIdMap.get(String(row.id));
      if (!mappedId || !hasTable(db, 'sessions')) return true;
      const local = db.prepare('SELECT source, status FROM sessions WHERE id = ?').get(mappedId) as
        { source?: string; status?: string } | undefined;
      return !(local?.source === 'shared' && local.status === 'deleted');
    });
    const messageIdMap = new Map<string, string>();
    if (siblingMessages) {
      for (const row of rowsToImport) {
        const messages = siblingMessages.all(row.id) as Array<Record<string, unknown>>;
        for (const message of messages) {
          messageIdMap.set(
            String(message.id),
            useStableIds
              ? stableMappedId(sourceOwnerId, 'message', message.id)
              : String(message.id),
          );
        }
      }
    }

    const writeAll = db.transaction(() => {
      for (const row of rowsToImport) {
        const params: Record<string, unknown> = {};
        for (const col of usableSessionCols) {
          // 跨账号镜像必须带共享来源标记；否则关闭共享时无法区分本地会话。
          if (col === 'id') {
            params[col] = sessionIdMap.get(String(row.id));
          } else if (col === 'source') {
            params[col] = 'shared';
          } else if (col === 'parent_session_id') {
            params[col] = row[col] == null ? null : (sessionIdMap.get(String(row[col])) ?? null);
          } else if (col === 'forked_at_message_id') {
            params[col] = row[col] == null ? null : (messageIdMap.get(String(row[col])) ?? null);
          } else if (SENSITIVE_SESSION_COLUMNS.has(col)) {
            // 目录授权字段有 NOT NULL 约束；跨账号只保留安全空数组，绝不复制权限。
            params[col] = col === 'extra_dirs' || col === 'writable_dirs' ? '[]' : null;
          } else {
            params[col] = row[col];
          }
        }
        const result = sessionInsert.run(params);
        sessionsUpserted += result.changes > 0 ? 1 : 0;
        sessionIds.push(String(row.id));
      }
      if (!messageInsert || !siblingMessages) return;
      for (const sessionId of sessionIds) {
        const rows = siblingMessages.all(sessionId) as Array<Record<string, unknown>>;
        for (const row of rows) {
          const params: Record<string, unknown> = {};
          for (const col of usableMessageCols) {
            if (col === 'id') params[col] = messageIdMap.get(String(row.id));
            else if (col === 'session_id') params[col] = sessionIdMap.get(String(row.session_id));
            else if (SENSITIVE_MESSAGE_COLUMNS.has(col)) params[col] = null;
            else params[col] = row[col];
          }
          const result = messageInsert.run(params);
          messagesCopied += result.changes;
        }
      }
      copySessionMedia(db, sibling, sessionIds, sourceOwnerId, useStableIds);
    });
    writeAll();
    return {
      sessionsUpserted,
      messagesCopied,
      sessionIds: sessionIds.map((id) => sessionIdMap.get(id)!),
    };
  } finally {
    sibling.close();
  }
}

/** 根据会话的项目绑定字段过滤跨账号镜像，避免关闭某类共享后仍复制消息。 */
function filterSessionRows(
  rows: Array<Record<string, unknown>>,
  localProjectSync?: LocalProjectSyncOptions | null,
): Array<Record<string, unknown>> {
  if (!localProjectSync) return rows;
  return rows.filter((row) => {
    const projectId = row.project_id ?? row.projectId ?? row.worktree_id ?? row.worktreeId;
    const isProjectConversation =
      projectId !== null && projectId !== undefined && String(projectId).trim() !== '';
    return isProjectConversation
      ? localProjectSync.projectConversation
      : localProjectSync.independentConversations;
  });
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
  sourceOwnerId: string,
  useStableIds: boolean,
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
  const blobCols =
    hasTable(sibling, 'media_blobs') && hasTable(db, 'media_blobs')
      ? tableColumns(sibling, 'media_blobs').filter((c) =>
          tableColumns(db, 'media_blobs').includes(c),
        )
      : [];
  const blobInsert =
    blobCols.length > 0
      ? db.prepare(
          `INSERT OR IGNORE INTO media_blobs (${blobCols
            .map(quoteIdent)
            .join(', ')}) VALUES (${blobCols.map((c) => `@${c}`).join(', ')})`,
        )
      : null;
  const blobSelect =
    blobCols.length > 0 ? sibling.prepare('SELECT * FROM media_blobs WHERE hash = ?') : null;
  const hashes = [...new Set(refRows.map((r) => String(r.hash)).filter(Boolean))];
  for (const hash of hashes) {
    const blob = blobSelect?.get(hash) as Record<string, unknown> | undefined;
    if (!blob || !blobInsert) continue;
    const params: Record<string, unknown> = {};
    for (const col of blobCols) params[col] = blob[col];
    blobInsert.run(params);
  }
  const refInsert = db.prepare(
    `INSERT OR IGNORE INTO media_refs (${refCols.map(quoteIdent).join(', ')}) VALUES (${refCols
      .map((c) => `@${c}`)
      .join(', ')})`,
  );
  for (const row of refRows) {
    const params: Record<string, unknown> = {};
    for (const col of refCols) {
      if (col === 'id')
        params[col] = useStableIds ? stableMappedId(sourceOwnerId, 'media-ref', row.id) : row.id;
      else if (col === 'ref_id')
        params[col] = useStableIds
          ? stableMappedId(sourceOwnerId, 'message', row.ref_id)
          : row.ref_id;
      else if (col === 'origin_session_id') {
        params[col] =
          row[col] == null
            ? null
            : useStableIds
              ? stableMappedId(sourceOwnerId, 'session', row[col])
              : row[col];
      } else {
        params[col] = row[col];
      }
    }
    refInsert.run(params);
  }
}
