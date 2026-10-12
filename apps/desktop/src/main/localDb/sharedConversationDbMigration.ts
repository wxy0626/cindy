import fs from 'node:fs';
import path from 'node:path';
import type Database from 'better-sqlite3';

import { createBetterSqliteDatabase } from './betterSqliteFactory.js';

type Row = Record<string, unknown>;

/** 这些表属于本机共享配置/伙伴索引，不应因切换 owner 而丢失。 */
const SHARED_LOCAL_TABLES = [
  'custom_providers',
  'custom_mcp_servers',
  'bot_profiles',
  'bot_profile_versions',
  'bot_session_links',
  'bot_runtime_snapshots',
  'bot_lifecycle_events',
  'bot_delegations',
  'bot_direct_message_threads',
  'bot_direct_messages',
  'daily_spend',
  'daily_model_usage',
] as const;

function hasTable(db: Database.Database, name: string): boolean {
  return Boolean(
    db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name),
  );
}

function hasRows(db: Database.Database, table: string): boolean {
  return db.prepare(`SELECT 1 FROM ${quote(table)} LIMIT 1`).get() != null;
}

function mergeSharedLocalTable(
  target: Database.Database,
  input: Database.Database,
  table: string,
): void {
  if (!hasTable(target, table) || !hasTable(input, table)) return;
  // 用量表是按天聚合的事实表。只有目标表为空时才做一次跨旧库合并，
  // 避免每次启动重复累加；后续新增用量都直接写入共享库。
  if ((table === 'daily_spend' || table === 'daily_model_usage') && hasRows(target, table)) {
    return;
  }
  const targetCols = columns(target, table);
  const inputCols = columns(input, table);
  const sharedCols = targetCols.filter((column) => inputCols.includes(column));
  if (sharedCols.length === 0) return;
  if (table === 'daily_spend' || table === 'daily_model_usage') {
    const keyColumns =
      table === 'daily_spend'
        ? ['day', 'cost_currency']
        : ['day', 'agent_kind', 'model', 'cost_currency'];
    const amountColumns = [
      'cost_usd',
      'cost_amount',
      'input_tokens',
      'output_tokens',
      'cache_read_tokens',
      'cache_create_tokens',
    ].filter((column) => sharedCols.includes(column));
    const conflictColumns = keyColumns.filter((column) => sharedCols.includes(column));
    if (conflictColumns.length === keyColumns.length) {
      const updates = amountColumns.map(
        (column) => `${quote(column)} = ${quote(column)} + excluded.${quote(column)}`,
      );
      if (sharedCols.includes('cost_is_approximate')) {
        updates.push(
          `${quote('cost_is_approximate')} = ` +
            `(${quote('cost_is_approximate')} OR excluded.${quote('cost_is_approximate')})`,
        );
      }
      if (sharedCols.includes('updated_at')) {
        updates.push(
          `${quote('updated_at')} = MAX(${quote('updated_at')}, excluded.${quote('updated_at')})`,
        );
      }
      const aggregateInsert = target.prepare(
        `INSERT INTO ${quote(table)} (${sharedCols.map(quote).join(', ')}) VALUES (` +
          sharedCols.map((column) => '@' + column).join(', ') +
          `) ON CONFLICT (${conflictColumns.map(quote).join(', ')}) DO UPDATE SET ` +
          updates.join(', '),
      );
      for (const row of input.prepare(`SELECT * FROM ${quote(table)}`).all() as Row[]) {
        aggregateInsert.run(row);
      }
      return;
    }
  }
  const insert = target.prepare(
    `INSERT OR IGNORE INTO ${quote(table)} (` +
      sharedCols.map(quote).join(', ') +
      ') VALUES (' +
      sharedCols.map((column) => '@' + column).join(', ') +
      ')',
  );
  for (const row of input.prepare(`SELECT * FROM ${quote(table)}`).all() as Row[]) {
    insert.run(row);
  }
}

function columns(db: Database.Database, table: string): string[] {
  return (
    db.pragma('table_info(\"' + table.replaceAll('\"', '\"\"') + '\")') as Array<{ name: string }>
  ).map((row) => row.name);
}

function quote(name: string): string {
  return '\"' + name.replaceAll('\"', '\"\"') + '\"';
}

function sessionKey(row: Row): string {
  return JSON.stringify([
    row.title ?? '',
    row.created_at ?? null,
    row.workspace_kind ?? null,
    row.working_dir ?? null,
    row.remote_host_id ?? null,
  ]);
}

function sourceDbPaths(root: string, target: string, prefix: string): string[] {
  let entries: string[];
  try {
    entries = fs.readdirSync(root);
  } catch {
    return [];
  }
  return entries
    .filter((name) => name.startsWith(prefix + '-') && name.endsWith('.db'))
    .map((name) => path.join(root, name))
    .filter((filePath) => path.resolve(filePath) !== path.resolve(target));
}

/** 将历史按账号分库的会话合并到单一共享库；删除状态不会迁入。 */
export function migrateToSharedConversationDb(
  root: string,
  targetPath: string,
  prefix: string,
): void {
  fs.mkdirSync(root, { recursive: true });
  const inputs = sourceDbPaths(root, targetPath, prefix);
  if (inputs.length === 0) return;
  // 共享库可能在历史版本中已经被创建，但当时没有成功迁入旧分库。
  // 不能只看目标库 mtime：目标库可能是“已创建但只迁入了少量数据”的半成品。
  // 这里每次都做幂等补迁，确保旧 owner 中新增或遗漏的数据最终可见。
  const targetExists = fs.existsSync(targetPath);
  if (!targetExists) fs.copyFileSync(inputs[0], targetPath);
  const target = createBetterSqliteDatabase(targetPath);
  target.pragma('journal_mode = WAL');
  target.pragma('foreign_keys = ON');
  try {
    if (!hasTable(target, 'sessions')) return;
    const sessionCols = columns(target, 'sessions');
    const messageCols = hasTable(target, 'messages') ? columns(target, 'messages') : [];
    const deletedKeys = new Set<string>();
    const liveKeys = new Set<string>();
    for (const row of target
      .prepare("SELECT * FROM sessions WHERE status = 'deleted'")
      .all() as Row[])
      deletedKeys.add(sessionKey(row));
    for (const row of target
      .prepare("SELECT * FROM sessions WHERE COALESCE(status, 'active') != 'deleted'")
      .all() as Row[])
      liveKeys.add(sessionKey(row));
    for (const inputPath of inputs) {
      let input: Database.Database | null = null;
      try {
        input = createBetterSqliteDatabase(inputPath, { readonly: true, fileMustExist: true });
        if (hasTable(input, 'sessions')) {
          for (const row of input
            .prepare("SELECT * FROM sessions WHERE status = 'deleted'")
            .all() as Row[])
            deletedKeys.add(sessionKey(row));
          for (const row of input
            .prepare("SELECT * FROM sessions WHERE COALESCE(status, 'active') != 'deleted'")
            .all() as Row[])
            liveKeys.add(sessionKey(row));
        }
      } finally {
        input?.close();
      }
    }
    for (const row of target.prepare('SELECT id, * FROM sessions').all() as Row[]) {
      if (deletedKeys.has(sessionKey(row)) && !liveKeys.has(sessionKey(row)))
        target.prepare('DELETE FROM sessions WHERE id = ?').run(row.id);
    }
    const known = new Map<string, string>();
    for (const row of target.prepare('SELECT * FROM sessions').all() as Row[]) {
      if (row.status !== 'deleted') known.set(sessionKey(row), String(row.id));
    }
    // 首次创建时第一份源库已经作为目标基底复制完成；已有目标库扫描全部源库，
    // 让历史半成品也能补齐。
    const sourceInputs = targetExists ? inputs : inputs.slice(1);
    for (const inputPath of sourceInputs) {
      let input: Database.Database | null = null;
      try {
        input = createBetterSqliteDatabase(inputPath, { readonly: true, fileMustExist: true });
        for (const table of SHARED_LOCAL_TABLES) {
          mergeSharedLocalTable(target, input, table);
        }
        if (!hasTable(input, 'sessions')) continue;
        const inputSessionCols = columns(input, 'sessions');
        const inputMessageCols = hasTable(input, 'messages') ? columns(input, 'messages') : [];
        const rows = input
          .prepare("SELECT * FROM sessions WHERE COALESCE(status, 'active') != 'deleted'")
          .all() as Row[];
        const idMap = new Map<string, string>();
        const cols = sessionCols.filter((column) => inputSessionCols.includes(column));
        const insert = target.prepare(
          'INSERT OR IGNORE INTO sessions (' +
            cols.map(quote).join(', ') +
            ') VALUES (' +
            cols.map((column) => '@' + column).join(', ') +
            ')',
        );
        for (const row of rows) {
          const key = sessionKey(row);
          if (deletedKeys.has(key)) continue;
          let id = known.get(key);
          if (!id) {
            insert.run(row);
            id = String(row.id);
            known.set(key, id);
          }
          idMap.set(String(row.id), id);
        }
        if (messageCols.length && inputMessageCols.includes('session_id') && idMap.size) {
          const cols = messageCols.filter((column) => inputMessageCols.includes(column));
          const values = cols
            .map((column) => (column === 'session_id' ? '@mapped_session_id' : '@' + column))
            .join(', ');
          const insert = target.prepare(
            'INSERT OR IGNORE INTO messages (' +
              cols.map(quote).join(', ') +
              ') VALUES (' +
              values +
              ')',
          );
          for (const row of input.prepare('SELECT * FROM messages').all() as Row[]) {
            const id = idMap.get(String(row.session_id));
            if (id) insert.run({ ...row, mapped_session_id: id });
          }
        }
      } finally {
        input?.close();
      }
    }
  } finally {
    target.close();
  }
}
