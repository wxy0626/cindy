import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { CindyRegion } from '@cindy/maker-shared/brand-identity';
import type { DevProfileKind } from './devCliFlags.js';
import { withLocalProfileMigrationStartupBarrier } from './localProfileDataMigration.js';
import { atomicWriteFileSync } from './utils/atomicWriteFile.js';

export type DesktopDevMode = 'remote' | 'local' | 'unknown';
export type DesktopDevInstanceState = 'starting' | 'ready' | 'failed';
export type DesktopDevAuthMode = 'signed-out' | 'local' | 'cloud';
export interface DesktopDevAuthState { mode: DesktopDevAuthMode; dataOwnerId: string | null; }

export interface DesktopDevInstanceRecord {
  schemaVersion: 1; worktreeLeaseProtocol?: 1; instanceId: string; pid: number;
  startedAtMs: number; updatedAtMs: number; rootDir: string; commit: string | null;
  mode: DesktopDevMode; region: CindyRegion; passive: boolean; isolated: boolean;
  isolationIntent?: boolean; profileKind?: DevProfileKind; userDataDir: string;
  state: DesktopDevInstanceState;
  failure?: { code: string; message: string; detail?: Record<string, unknown> };
}
export interface BeginDesktopDevInstanceOptions {
  userDataDir: string; dbFilePrefix: string; rootDir: string; commit?: string | null;
  mode?: DesktopDevMode; region?: CindyRegion; passive: boolean; isolated: boolean;
  isolationIntent?: boolean; profileKind?: DevProfileKind; pid?: number;
  startedAtMs?: number; instanceId?: string;
}
let trackedInstance: { filePath: string; record: DesktopDevInstanceRecord } | null = null;
let windowVisible = false;
let rendererRootReady = false;
let rendererLocalDbReady = false;
let authSettled = false;
let authMode: DesktopDevAuthMode | null = null;
let authOwnerId: string | null = null;
let startupSettled = false;
let authCompletionGeneration = 0;

function atomicWriteJson(filePath: string, value: unknown): void { atomicWriteFileSync(filePath, `${JSON.stringify(value)}\n`); }
function readJson(filePath: string): Record<string, unknown> | null { try { const v = JSON.parse(fs.readFileSync(filePath, 'utf8')) as unknown; return v && typeof v === 'object' ? v as Record<string, unknown> : null; } catch { return null; } }
function readinessSnapshot(): Record<string, unknown> { return { windowVisible, rendererRootReady, rendererLocalDbReady, authSettled, authMode, authOwnerId }; }
function updateExternalStartupStatus(state: 'window-ready' | 'ready' | 'failed', detail: Record<string, unknown>): void {
  const statusPath = process.env.XDT_DESKTOP_DEV_STARTUP_STATUS_FILE; if (!statusPath) return;
  try {
    const current = readJson(statusPath)?.state;
    const allowed = state === 'window-ready'
      ? current === 'pending'
      : current === 'pending' || current === 'window-ready';
    if (!allowed) return;
    const existingDetail = detail.detail && typeof detail.detail === 'object'
      ? detail.detail as Record<string, unknown>
      : {};
    atomicWriteJson(statusPath, {
      state,
      pid: process.pid,
      at: Date.now(),
      ...detail,
      detail: { ...existingDetail, readiness: readinessSnapshot() },
    });
  } catch { /* diagnostic only */ }
}
function updateTrackedInstance(state: DesktopDevInstanceState, failure?: DesktopDevInstanceRecord['failure']): void {
  if (!trackedInstance) return;
  const record = { ...trackedInstance.record, state, updatedAtMs: Date.now(), ...(failure ? { failure } : {}) };
  try { atomicWriteJson(trackedInstance.filePath, record); trackedInstance.record = record; } catch { /* diagnostic only */ }
}
export async function beginDesktopDevInstance(options: BeginDesktopDevInstanceOptions): Promise<() => void> {
  windowVisible = false; rendererRootReady = false; rendererLocalDbReady = false; authSettled = false; authMode = null; authOwnerId = null; startupSettled = false; authCompletionGeneration += 1;
  const pid = options.pid ?? process.pid; const startedAtMs = options.startedAtMs ?? Date.now();
  const record: DesktopDevInstanceRecord = { schemaVersion: 1, worktreeLeaseProtocol: 1, instanceId: options.instanceId ?? randomUUID(), pid, startedAtMs, updatedAtMs: startedAtMs, rootDir: path.resolve(options.rootDir), commit: options.commit ?? null, mode: options.mode ?? 'unknown', region: options.region ?? 'global', passive: options.passive, isolated: options.isolated, ...(options.isolationIntent !== undefined ? { isolationIntent: options.isolationIntent } : {}), ...(options.profileKind !== undefined ? { profileKind: options.profileKind } : {}), userDataDir: path.resolve(options.userDataDir), state: 'starting' };
  const filePath = path.join(record.userDataDir, '.dev-instances', `${pid}.json`);
  try { await withLocalProfileMigrationStartupBarrier(record.userDataDir, options.dbFilePrefix, () => { atomicWriteJson(filePath, record); trackedInstance = { filePath, record }; }); } catch (error) { markDesktopDevStartupFailed('INSTANCE_REGISTRATION_FAILED', error instanceof Error ? error.message : String(error), { phase: 'instance-registration' }); throw error; }
  return () => { if (trackedInstance?.record.instanceId === record.instanceId) trackedInstance = null; try { if (readJson(filePath)?.instanceId === record.instanceId) fs.rmSync(filePath, { force: true }); } catch { /* stale record is harmless */ } };
}
function settleDesktopDevReadyIfPossible(): void {
  if (startupSettled || !windowVisible || !rendererRootReady || !authSettled) return;
  if (authMode !== 'signed-out' && !rendererLocalDbReady) return;
  startupSettled = true; updateTrackedInstance('ready'); updateExternalStartupStatus('ready', { instance: trackedInstance?.record ?? null });
}
export function markDesktopDevWindowReady(): void { if (startupSettled) return; windowVisible = true; updateExternalStartupStatus('window-ready', { instance: trackedInstance?.record ?? null }); settleDesktopDevReadyIfPossible(); }
export function markDesktopDevRootReady(): void { if (startupSettled) return; rendererRootReady = true; settleDesktopDevReadyIfPossible(); }
export function markDesktopDevLocalDbReady(ownerId?: string): void { if (startupSettled || (authMode === 'cloud' && ownerId !== authOwnerId) || (authMode === 'local' && ownerId !== authOwnerId)) return; rendererLocalDbReady = true; settleDesktopDevReadyIfPossible(); }
export function markDesktopDevReady(): void { settleDesktopDevReadyIfPossible(); }
export function recordDesktopDevAuthStartupResult(initialState: DesktopDevAuthState | { mode?: DesktopDevAuthMode; dataOwnerId?: string | null; isAuthenticated?: boolean; user?: unknown | null }, pendingCompletion: Promise<DesktopDevAuthState> | null, readCurrentState: () => DesktopDevAuthState): void {
  // 兼容两种入参：新式 {mode,dataOwnerId} 直接用；旧式 {isAuthenticated,user} 归一为 mode/owner。
  const state: DesktopDevAuthState = initialState.mode
    ? { mode: initialState.mode, dataOwnerId: initialState.dataOwnerId ?? null }
    : {
        mode: initialState.isAuthenticated ? 'cloud' : 'signed-out',
        dataOwnerId:
          initialState.user && typeof initialState.user === 'object' && 'id' in initialState.user
            ? String((initialState.user as { id: unknown }).id)
            : null,
      };
  authMode = state.mode; authOwnerId = state.dataOwnerId;
  const generation = ++authCompletionGeneration;
  if (pendingCompletion) { void pendingCompletion.then(() => { if (generation !== authCompletionGeneration || startupSettled) return; const current = readCurrentState(); authMode = current.mode; authOwnerId = current.dataOwnerId; authSettled = true; settleDesktopDevReadyIfPossible(); }, (error) => { if (generation === authCompletionGeneration) markDesktopDevStartupFailed('AUTH_INIT_FAILED', error instanceof Error ? error.message : String(error), { phase: 'auth:initialize:late' }); }); return; }
  authSettled = true; settleDesktopDevReadyIfPossible();
}
export function recordDesktopDevLocalDbStartupResult(result: { ready: boolean; error?: { code: string; message: string } }): void { if (!result.ready && result.error) markDesktopDevStartupFailed(result.error.code, result.error.message, { phase: 'local-db:ensure-ready' }); }
export function markDesktopDevStartupFailed(code: string, message: string, detail?: Record<string, unknown>): void { if (startupSettled) return; startupSettled = true; const failure = { code, message, ...(detail ? { detail } : {}) }; updateTrackedInstance('failed', failure); updateExternalStartupStatus('failed', failure); }
