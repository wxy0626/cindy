/**
 * crossOwnerSessionSync 单元测试 —— 本机跨账号 / 跨版本会话镜像同步。
 *
 * 覆盖:
 *   1. 兄弟库发现(排除当前 owner 自身 / 备份产物 / 重复 realpath)
 *   2. 新会话整行导入 + messages 复制 + media 幂等拷贝
 *   3. updated_at 收敛:本地较新不覆盖、源较新整行覆盖、软删墓碑传播
 *   4. schema 差异:兄弟库缺列时按共有列拷贝,不炸
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type Database from 'better-sqlite3';

import {
  discoverSiblingOwnerDbPaths,
  syncSessionsFromSiblingDbs,
} from '../crossOwnerSessionSync';
import { createBetterSqliteDatabase } from '../betterSqliteFactory';

let tempRoot: string;

beforeEach(() => {
  tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cross-owner-sync-'));
});

afterEach(() => {
  fs.rmSync(tempRoot, { recursive: true, force: true });
});

const SESSION_SCHEMA = `
  CREATE TABLE sessions (
    id TEXT PRIMARY KEY,
    title TEXT,
    status TEXT,
    source TEXT,
    updated_at INTEGER,
    extra_local_col TEXT
  );
`;
const MESSAGE_SCHEMA = `
  CREATE TABLE messages (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    content TEXT,
    rewind_at INTEGER
  );
`;
const MEDIA_SCHEMA = `
  CREATE TABLE media_refs (id TEXT PRIMARY KEY, hash TEXT, origin_session_id TEXT);
  CREATE TABLE media_blobs (hash TEXT PRIMARY KEY, bytes BLOB);
`;

function createDb(filePath: string, withExtraSessionCol = true): Database.Database {
  const db = createBetterSqliteDatabase(filePath);
  db.exec(SESSION_SCHEMA.replace(',\n    extra_local_col TEXT', withExtraSessionCol ? ',\n    extra_local_col TEXT' : ''));
  db.exec(MESSAGE_SCHEMA);
  db.exec(MEDIA_SCHEMA);
  return db;
}

function siblingDbPath(dir: string, ownerId: string): string {
  return path.join(dir, `cindy-${ownerId}.db`);
}

describe('discoverSiblingOwnerDbPaths', () => {
  it('枚举其它 owner 的库,排除当前 owner / 备份产物 / 非 cindy-*.db 文件', () => {
    const dir = path.join(tempRoot, 'CindyShared');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(siblingDbPath(dir, 'owner-a'), 'x');
    fs.writeFileSync(siblingDbPath(dir, 'owner-b'), 'x');
    fs.writeFileSync(siblingDbPath(dir, 'me'), 'x');
    fs.writeFileSync(siblingDbPath(dir, 'me') + '.bak.2026-09-03T00-00-00-000Z', 'x');
    fs.writeFileSync(path.join(dir, 'unrelated.db'), 'x');
    fs.writeFileSync(path.join(dir, 'cindy-broken.name.db'), 'x');

    const currentDb = siblingDbPath(dir, 'me');
    const found = discoverSiblingOwnerDbPaths(
      path.join(tempRoot, 'Cindy'),
      currentDb,
      'me',
    );
    const names = found.paths.map((p) => path.basename(p)).sort();
    expect(names).toEqual(['cindy-owner-a.db', 'cindy-owner-b.db']);
    expect(found.skippedCurrentOwner).toBe(1);
  });

  it('沙箱(非正式区域目录)额外回看正式区域目录与共享根', () => {
    const sharedRoot = path.join(tempRoot, 'CindyShared');
    fs.mkdirSync(sharedRoot, { recursive: true });
    fs.writeFileSync(siblingDbPath(sharedRoot, 'release-owner'), 'x');
    const sandboxDir = path.join(tempRoot, 'CindyGlobal-dev2-dev');
    fs.mkdirSync(sandboxDir, { recursive: true });
    fs.writeFileSync(siblingDbPath(sandboxDir, 'sandbox-owner'), 'x');

    const found = discoverSiblingOwnerDbPaths(
      sandboxDir,
      siblingDbPath(sandboxDir, 'me'),
      'me',
    );
    const names = found.paths.map((p) => path.basename(p)).sort();
    expect(names).toContain('cindy-release-owner.db');
    expect(names).toContain('cindy-sandbox-owner.db');
  });
});

describe('syncSessionsFromSiblingDbs', () => {
  it('新会话整行导入、messages 与 media 幂等拷贝', async () => {
    const dir = path.join(tempRoot, 'CindyShared');
    fs.mkdirSync(dir, { recursive: true });
    const sibling = createDb(siblingDbPath(dir, 'owner-a'));
    sibling
      .prepare(
        "INSERT INTO sessions (id, title, status, source, updated_at) VALUES ('s-1', '来自兄弟账号', 'active', 'desktop', 100)",
      )
      .run();
    sibling
      .prepare("INSERT INTO messages (id, session_id, content, rewind_at) VALUES ('m-1', 's-1', 'hello', NULL)")
      .run();
    sibling
      .prepare("INSERT INTO media_refs (id, hash, origin_session_id) VALUES ('ref-1', 'hash-1', 's-1')")
      .run();
    sibling
      .prepare("INSERT INTO media_blobs (hash, bytes) VALUES ('hash-1', x'00ff')")
      .run();

    const me = createDb(siblingDbPath(dir, 'me'));
    const summary = await syncSessionsFromSiblingDbs({
      db: me,
      currentUserId: 'me',
      currentDbPath: siblingDbPath(dir, 'me'),
      userDataDir: path.join(tempRoot, 'Cindy'),
    });

    expect(summary.siblings).toBe(1);
    expect(summary.sessionsUpserted).toBe(1);
    expect(summary.messagesCopied).toBe(1);
    expect(me.prepare('SELECT title, status FROM sessions WHERE id = ?').get('s-1')).toEqual({
      title: '来自兄弟账号',
      status: 'active',
    });
    expect(me.prepare('SELECT content FROM messages WHERE id = ?').get('m-1')).toEqual({
      content: 'hello',
    });
    expect(me.prepare('SELECT hash FROM media_refs').all()).toEqual([{ hash: 'hash-1' }]);
    expect(me.prepare('SELECT hash FROM media_blobs').all()).toEqual([{ hash: 'hash-1' }]);

    // 幂等:再跑一遍不重复插入、不报错
    const again = await syncSessionsFromSiblingDbs({
      db: me,
      currentUserId: 'me',
      currentDbPath: siblingDbPath(dir, 'me'),
      userDataDir: path.join(tempRoot, 'Cindy'),
    });
    expect(again.sessionsUpserted).toBe(0);
    expect(me.prepare('SELECT count(*) AS n FROM messages').get()).toEqual({ n: 1 });
    sibling.close();
    me.close();
  });

  it('updated_at 收敛:本地较新保留、源较新覆盖、软删墓碑传播', () => {
    const dir = path.join(tempRoot, 'CindyShared');
    fs.mkdirSync(dir, { recursive: true });
    const sibling = createDb(siblingDbPath(dir, 'owner-a'));
    const ins = sibling.prepare(
      'INSERT INTO sessions (id, title, status, updated_at) VALUES (?, ?, ?, ?)',
    );
    ins.run('s-local-newer', '源里较旧', 'active', 50);
    ins.run('s-source-newer', '源里较新', 'active', 200);
    ins.run('s-deleted', '已被源删除', 'deleted', 300);

    const me = createDb(siblingDbPath(dir, 'me'));
    const local = me.prepare(
      'INSERT INTO sessions (id, title, status, updated_at) VALUES (?, ?, ?, ?)',
    );
    local.run('s-local-newer', '本地较新', 'active', 100);
    local.run('s-source-newer', '本地较旧', 'active', 100);
    local.run('s-deleted', '本地还活着', 'active', 100);

    syncSessionsFromSiblingDbs({
      db: me,
      currentUserId: 'me',
      currentDbPath: siblingDbPath(dir, 'me'),
      userDataDir: path.join(tempRoot, 'Cindy'),
    });

    expect(
      (me.prepare('SELECT title FROM sessions WHERE id = ?').get('s-local-newer') as { title: string }).title,
    ).toBe('本地较新');
    expect(
      (me.prepare('SELECT title FROM sessions WHERE id = ?').get('s-source-newer') as { title: string }).title,
    ).toBe('源里较新');
    expect(
      (me.prepare('SELECT status FROM sessions WHERE id = ?').get('s-deleted') as { status: string }).status,
    ).toBe('deleted');
    sibling.close();
    me.close();
  });

  it('schema 差异:兄弟库缺本地新列时按共有列拷贝,不炸', async () => {
    const dir = path.join(tempRoot, 'CindyShared');
    fs.mkdirSync(dir, { recursive: true });
    // 兄弟库没有 extra_local_col 列
    const sibling = createDb(siblingDbPath(dir, 'owner-a'), false);
    sibling
      .prepare("INSERT INTO sessions (id, title, status, updated_at) VALUES ('s-1', '旧 schema 会话', 'active', 100)")
      .run();
    // 本地多一列 extra_local_col(有 NOT 语义的默认即可,这里可空)
    const me = createDb(siblingDbPath(dir, 'me'));

    const summary = await syncSessionsFromSiblingDbs({
      db: me,
      currentUserId: 'me',
      currentDbPath: siblingDbPath(dir, 'me'),
      userDataDir: path.join(tempRoot, 'Cindy'),
    });
    expect(summary.failed).toHaveLength(0);
    expect(
      (me.prepare('SELECT title FROM sessions WHERE id = ?').get('s-1') as { title: string }).title,
    ).toBe('旧 schema 会话');
    sibling.close();
    me.close();
  });
});
