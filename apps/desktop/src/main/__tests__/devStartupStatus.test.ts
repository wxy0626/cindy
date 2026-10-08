import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  beginDesktopDevInstance,
  markDesktopDevLocalDbReady,
  markDesktopDevRootReady,
  markDesktopDevStartupFailed,
  markDesktopDevWindowReady,
  recordDesktopDevAuthStartupResult,
  recordDesktopDevLocalDbStartupResult,
} from '../devStartupStatus.js';

describe('devStartupStatus strict renderer readiness', () => {
  let dir: string; let status: string; let cleanup: (() => void) | null;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-dev-status-')); status = path.join(dir, 'startup.json'); process.env.XDT_DESKTOP_DEV_STARTUP_STATUS_FILE = status; fs.writeFileSync(status, '{"state":"pending"}\n'); cleanup = null; });
  afterEach(() => { cleanup?.(); delete process.env.XDT_DESKTOP_DEV_STARTUP_STATUS_FILE; fs.rmSync(dir, { recursive: true, force: true }); });
  const begin = async (mode: 'signed-out' | 'local' | 'cloud' = 'signed-out', owner: string | null = null) => { cleanup = await beginDesktopDevInstance({ userDataDir: dir, dbFilePrefix: 'cindy', rootDir: dir, passive: false, isolated: false, pid: Math.floor(Math.random() * 100000) }); recordDesktopDevAuthStartupResult({ mode, dataOwnerId: owner }, null, () => ({ mode, dataOwnerId: owner })); };
  it('requires window, root, auth and DB for cloud, in any order', async () => { await begin('cloud', 'u1'); markDesktopDevLocalDbReady('u1'); markDesktopDevRootReady(); expect(JSON.parse(fs.readFileSync(status, 'utf8')).state).toBe('pending'); markDesktopDevWindowReady(); expect(JSON.parse(fs.readFileSync(status, 'utf8')).state).toBe('ready'); });
  it('signed-out does not require DB, while local does', async () => { await begin(); markDesktopDevRootReady(); markDesktopDevWindowReady(); expect(JSON.parse(fs.readFileSync(status, 'utf8')).state).toBe('ready'); fs.writeFileSync(status, '{"state":"pending"}\n'); await begin('local', 'local-user'); markDesktopDevRootReady(); markDesktopDevWindowReady(); expect(JSON.parse(fs.readFileSync(status, 'utf8')).state).toBe('window-ready'); markDesktopDevLocalDbReady('wrong'); expect(JSON.parse(fs.readFileSync(status, 'utf8')).state).toBe('window-ready'); markDesktopDevLocalDbReady('local-user'); expect(JSON.parse(fs.readFileSync(status, 'utf8')).state).toBe('ready'); });
  it('ignores duplicate and late failure, preserves first failure', async () => { await begin(); markDesktopDevRootReady(); markDesktopDevRootReady(); markDesktopDevWindowReady(); markDesktopDevWindowReady(); expect(JSON.parse(fs.readFileSync(status, 'utf8')).state).toBe('ready'); markDesktopDevStartupFailed('LATE', 'ignored'); expect(JSON.parse(fs.readFileSync(status, 'utf8')).state).toBe('ready'); fs.writeFileSync(status, '{"state":"pending"}\n'); await begin('cloud', 'u1'); markDesktopDevStartupFailed('FIRST', 'first'); markDesktopDevStartupFailed('SECOND', 'second'); const result = JSON.parse(fs.readFileSync(status, 'utf8')); expect(result.code).toBe('FIRST'); expect(result.detail.readiness).toBeTruthy(); });
  it('pending auth success reads current state and rejection is first-wins', async () => { let resolve!: (value?: any) => void; const pending = new Promise<any>((r) => { resolve = r; }); cleanup = await beginDesktopDevInstance({ userDataDir: dir, dbFilePrefix: 'cindy', rootDir: dir, passive: false, isolated: false, pid: 10001 }); recordDesktopDevAuthStartupResult({ mode: 'cloud', dataOwnerId: 'u1' }, pending, () => ({ mode: 'cloud', dataOwnerId: 'u1' })); markDesktopDevRootReady(); markDesktopDevWindowReady(); expect(JSON.parse(fs.readFileSync(status, 'utf8')).state).toBe('window-ready'); resolve(); await pending; await Promise.resolve(); expect(JSON.parse(fs.readFileSync(status, 'utf8')).state).toBe('window-ready'); markDesktopDevLocalDbReady('u1'); expect(JSON.parse(fs.readFileSync(status, 'utf8')).state).toBe('ready'); });
  it('local DB errors fail but success alone never declares ready', async () => { await begin('local', 'u1'); markDesktopDevRootReady(); markDesktopDevWindowReady(); recordDesktopDevLocalDbStartupResult({ ready: true }); expect(JSON.parse(fs.readFileSync(status, 'utf8')).state).toBe('window-ready'); recordDesktopDevLocalDbStartupResult({ ready: false, error: { code: 'MIGRATE_FAILED', message: 'bad' } }); expect(JSON.parse(fs.readFileSync(status, 'utf8')).code).toBe('MIGRATE_FAILED'); });
});
