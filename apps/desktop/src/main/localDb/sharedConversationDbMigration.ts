import fs from 'node:fs';
import path from 'node:path';
import type Database from 'better-sqlite3';

import { createBetterSqliteDatabase } from './betterSqliteFactory.js';

type Row = Record<string, unknown>;

function hasTable(db: Database.Database, name: string): boolean {
  return Boolean(
    db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name),
  );
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
  if (fs.existsSync(targetPath)) return;
  const inputs = sourceDbPaths(root, targetPath, prefix);
  if (inputs.length === 0) return;
  fs.copyFileSync(inputs[0], targetPath);
  const target = createBetterSqliteDatabase(targetPath);
  target.pragma('journal_mode = WAL');
  target.pragma('foreign_keys = ON');
  try {
    if (!hasTable(target, 'sessions')) return;
    const sessionCols = columns(target, 'sessions');
    const messageCols = hasTable(target, 'messages') ? columns(target, 'messages') : [];
    const deletedKeys = new Set<string>();
    for (const row of target
      .prepare("SELECT * FROM sessions WHERE status = 'deleted'")
      .all() as Row[])
      deletedKeys.add(sessionKey(row));
    for (const inputPath of inputs) {
      let input: Database.Database | null = null;
      try {
        input = createBetterSqliteDatabase(inputPath, { readonly: true, fileMustExist: true });
        if (hasTable(input, 'sessions')) {
          for (const row of input
            .prepare("SELECT * FROM sessions WHERE status = 'deleted'")
            .all() as Row[])
            deletedKeys.add(sessionKey(row));
        }
      } finally {
        input?.close();
      }
    }
    for (const row of target.prepare('SELECT id, * FROM sessions').all() as Row[]) {
      if (deletedKeys.has(sessionKey(row)))
        target.prepare('DELETE FROM sessions WHERE id = ?').run(row.id);
    }
    const known = new Map<string, string>();
    for (const row of target.prepare('SELECT * FROM sessions').all() as Row[]) {
      if (row.status !== 'deleted') known.set(sessionKey(row), String(row.id));
    }
    for (const inputPath of inputs.slice(1)) {
      let input: Database.Database | null = null;
      try {
        input = createBetterSqliteDatabase(inputPath, { readonly: true, fileMustExist: true });
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
