import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { CindyRegion } from '@cindy/maker-shared/brand-identity';
import type { DevProfileKind } from './devCliFlags.js';
import { withLocalProfileMigrationStartupBarrier } from './localProfileDataMigration.js';
import { atomicWriteFileSync } from './utils/atomicWriteFile.js';
import {
  readDesktopProcessIdentity,
  type DesktopProcessIdentity,
} from './desktopProcessIdentity.js';

export type DesktopDevMode = 'remote' | 'local' | 'unknown';
export type DesktopDevInstanceState = 'starting' | 'ready' | 'failed';
export type DesktopDevAuthMode = 'signed-out' | 'local' | 'cloud';

export interface DesktopDevAuthState {
  mode: DesktopDevAuthMode;
  dataOwnerId: string | null;
}

interface LegacyDesktopDevAuthState {
  mode?: DesktopDevAuthMode;
  dataOwnerId?: string | null;
  isAuthenticated?: boolean;
  user?: unknown | null;
}

/**
 * Runtime provenance persisted under the effective userData directory.
 * Written by dev AND packaged instances: dev/release share a userData with
 * per-flavor single-instance lock scopes, and the owner-namespace migration's
 * exclusivity guard discovers concurrent instances through this registry, so
 * packaged instances must register too.
 */
export interface DesktopDevInstanceRecord {
  schemaVersion: 1;
  worktreeLeaseProtocol?: 1;
  instanceId: string;
  pid: number;
  /** Main reports the actual window renderer; Linux zygote children may retain argv. */
  rendererPid?: number;
  startedAtMs: number;
  /** Optional for legacy readers/writers; absence never claims that a PID is stale. */
  processIdentity?: DesktopProcessIdentity;
  updatedAtMs: number;
  rootDir: string;
  commit: string | null;
  mode: DesktopDevMode;
  /** 构建区域；共享 userData 启动器据此拒绝跨区域 passive 预览。 */
  region: CindyRegion;
  passive: boolean;
  /** 解析后是否真的落在独立纪元沙箱。不是「有 userData 覆写」。 */
  isolated: boolean;
  /** 启动旗标是否声明了 --isolated / XDT_ISOLATED。 */
  isolationIntent?: boolean;
  /** 解析后的实际 profile 归属。 */
  profileKind?: DevProfileKind;
  userDataDir: string;
  state: DesktopDevInstanceState;
  failure?: {
    code: string;
    message: string;
    detail?: Record<string, unknown>;
  };
}

export interface BeginDesktopDevInstanceOptions {
  userDataDir: string;
  dbFilePrefix: string;
  rootDir: string;
  commit?: string | null;
  mode?: DesktopDevMode;
  region?: CindyRegion;
  passive: boolean;
  isolated: boolean;
  isolationIntent?: boolean;
  profileKind?: DevProfileKind;
  pid?: number;
  startedAtMs?: number;
  instanceId?: string;
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
let startupResult: boolean | undefined;
const startupResultListeners = new Set<(ready: boolean) => void>();

/** Local version handoff consumes the existing auth + database + window readiness contract. */
export function observeDesktopStartupResult(listener: (ready: boolean) => void): () => void {
  if (startupResult !== undefined) listener(startupResult);
  else startupResultListeners.add(listener);
  return () => startupResultListeners.delete(listener);
}

function publishDesktopStartupResult(ready: boolean): void {
  startupResult = ready;
  for (const listener of startupResultListeners) {
    try {
      listener(ready);
    } catch {
      // A diagnostic observer must never affect startup.
    }
  }
  startupResultListeners.clear();
}

function atomicWriteJson(filePath: string, value: unknown): void {
  atomicWriteFileSync(filePath, `${JSON.stringify(value)}\n`);
}

function readJson(filePath: string): Record<string, unknown> | null {
  try {
    const value = JSON.parse(fs.readFileSync(filePath, 'utf8')) as unknown;
    return value !== null && typeof value === 'object' ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function readinessSnapshot(): Record<string, unknown> {
  return {
    windowVisible,
    rendererRootReady,
    rendererLocalDbReady,
    authSettled,
    authMode,
    authOwnerId,
  };
}

function updateExternalStartupStatus(
  state: 'window-ready' | 'ready' | 'failed',
  detail: Record<string, unknown>,
): void {
  const statusPath = process.env.XDT_DESKTOP_DEV_STARTUP_STATUS_FILE;
  if (!statusPath) return;

  try {
    const current = readJson(statusPath)?.state;
    const allowed =
      state === 'window-ready'
        ? current === 'pending'
        : current === 'pending' || current === 'window-ready';
    if (!allowed) return;
    const existingDetail =
      detail.detail && typeof detail.detail === 'object'
        ? (detail.detail as Record<string, unknown>)
        : {};
    atomicWriteJson(statusPath, {
      state,
      pid: process.pid,
      at: Date.now(),
      ...detail,
      detail: { ...existingDetail, readiness: readinessSnapshot() },
    });
  } catch {
    // Startup reporting is diagnostic-only; never turn a report failure into the app failure.
  }
}

function updateTrackedInstance(
  state: DesktopDevInstanceState,
  failure?: DesktopDevInstanceRecord['failure'],
  patch?: Partial<DesktopDevInstanceRecord>,
): void {
  if (!trackedInstance) return;
  const record: DesktopDevInstanceRecord = {
    ...trackedInstance.record,
    ...patch,
    state,
    updatedAtMs: Date.now(),
    ...(failure ? { failure } : {}),
  };
  try {
    atomicWriteJson(trackedInstance.filePath, record);
    trackedInstance.record = record;
  } catch {
    // Runtime provenance is best-effort and must never stop the product from opening.
  }
}

/**
 * Register this Electron main process before single-instance arbitration.
 * The returned cleanup only removes the record when its random instanceId still owns it.
 */
export async function beginDesktopDevInstance(
  options: BeginDesktopDevInstanceOptions,
): Promise<() => void> {
  windowVisible = false;
  rendererRootReady = false;
  rendererLocalDbReady = false;
  authSettled = false;
  authMode = null;
  authOwnerId = null;
  startupSettled = false;
  startupResult = undefined;
  authCompletionGeneration += 1;

  const pid = options.pid ?? process.pid;
  const startedAtMs = options.startedAtMs ?? Date.now();
  const record: DesktopDevInstanceRecord = {
    schemaVersion: 1,
    worktreeLeaseProtocol: 1,
    instanceId: options.instanceId ?? randomUUID(),
    pid,
    startedAtMs,
    updatedAtMs: startedAtMs,
    rootDir: path.resolve(options.rootDir),
    commit: options.commit ?? null,
    mode: options.mode ?? 'unknown',
    region: options.region ?? 'global',
    passive: options.passive,
    isolated: options.isolated,
    ...(options.isolationIntent !== undefined
      ? { isolationIntent: options.isolationIntent }
      : {}),
    ...(options.profileKind !== undefined ? { profileKind: options.profileKind } : {}),
    userDataDir: path.resolve(options.userDataDir),
    state: 'starting',
  };
  const filePath = path.join(record.userDataDir, '.dev-instances', `${pid}.json`);

  try {
    await withLocalProfileMigrationStartupBarrier(record.userDataDir, options.dbFilePrefix, () => {
      // Initial registration is part of the adoption safety protocol. If it
      // cannot be published, fail startup rather than continuing invisibly and
      // writing local-v1 while another process snapshots it.
      atomicWriteJson(filePath, record);
      trackedInstance = { filePath, record };
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    markDesktopDevStartupFailed('INSTANCE_REGISTRATION_FAILED', message, {
      phase: 'instance-registration',
    });
    throw error;
  }

  // bootstrap-electron is loaded after registration and must install privileged
  // schemes before Electron's ready event. Never await an OS subprocess here.
  void readDesktopProcessIdentity(pid)
    .then((identity) => {
      const current = trackedInstance;
      if (!identity || current?.record.instanceId !== record.instanceId) return;
      if (readJson(filePath)?.instanceId !== record.instanceId) return;
      updateTrackedInstance(current.record.state, current.record.failure, {
        processIdentity: identity,
      });
    })
    .catch(() => {
      // Failure to enrich must not affect startup or weaken legacy PID checks.
    });

  return () => {
    if (trackedInstance?.record.instanceId === record.instanceId) trackedInstance = null;
    try {
      if (readJson(filePath)?.instanceId === record.instanceId) {
        fs.rmSync(filePath, { force: true });
      }
    } catch {
      // A stale record is harmless: desktop:whoami verifies that the PID is alive.
    }
  };
}

function settleDesktopDevReadyIfPossible(): void {
  if (startupSettled || !windowVisible || !rendererRootReady || !authSettled) return;
  if (authMode !== 'signed-out' && !rendererLocalDbReady) return;
  startupSettled = true;
  updateTrackedInstance('ready');
  updateExternalStartupStatus('ready', { instance: trackedInstance?.record ?? null });
  publishDesktopStartupResult(true);
}

/** Record that the main BrowserWindow can render, without claiming the database is ready. */
export function markDesktopDevWindowReady(rendererPid?: number): void {
  if (startupSettled) return;
  const patch =
    trackedInstance && Number.isSafeInteger(rendererPid) && rendererPid! > 0
      ? { rendererPid }
      : undefined;
  updateTrackedInstance('starting', undefined, patch);
  windowVisible = true;
  updateExternalStartupStatus('window-ready', { instance: trackedInstance?.record ?? null });
  settleDesktopDevReadyIfPossible();
}

/** Record that the renderer root mounted and can route. */
export function markDesktopDevRootReady(): void {
  if (startupSettled) return;
  rendererRootReady = true;
  settleDesktopDevReadyIfPossible();
}

/** Record that the active owner's local database is ready. */
export function markDesktopDevLocalDbReady(ownerId?: string): void {
  if (
    startupSettled ||
    (authMode === 'cloud' && ownerId !== authOwnerId) ||
    (authMode === 'local' && ownerId !== authOwnerId)
  ) {
    return;
  }
  rendererLocalDbReady = true;
  settleDesktopDevReadyIfPossible();
}

/** Record that application-level initialization no longer blocks startup. */
export function markDesktopDevReady(): void {
  if (startupSettled) return;
  rendererRootReady = true;
  settleDesktopDevReadyIfPossible();
}

export function recordDesktopDevAuthStartupResult(
  initialState: DesktopDevAuthState | LegacyDesktopDevAuthState,
  pendingCompletion: Promise<DesktopDevAuthState | LegacyDesktopDevAuthState> | null,
  readCurrentState: () => DesktopDevAuthState,
): void {
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
  authMode = state.mode;
  authOwnerId = state.dataOwnerId;
  const generation = ++authCompletionGeneration;
  if (pendingCompletion) {
    void pendingCompletion.then(
      (resolved) => {
        if (generation !== authCompletionGeneration || startupSettled) return;
        const current = resolved?.mode
          ? {
              mode: resolved.mode,
              dataOwnerId: resolved.dataOwnerId ?? null,
            }
          : readCurrentState();
        authMode = current.mode;
        authOwnerId = current.dataOwnerId;
        authSettled = true;
        settleDesktopDevReadyIfPossible();
      },
      (error) => {
        if (generation === authCompletionGeneration) {
          markDesktopDevStartupFailed(
            'AUTH_INIT_FAILED',
            error instanceof Error ? error.message : String(error),
            { phase: 'auth:initialize:late' },
          );
        }
      },
    );
    return;
  }
  authSettled = true;
  settleDesktopDevReadyIfPossible();
}

/** Bridge localDb.ensureReady's stable result shape into the dev startup contract. */
export function recordDesktopDevLocalDbStartupResult(result: {
  ready: boolean;
  error?: { code: string; message: string };
}): void {
  if (!result.ready && result.error) {
    markDesktopDevStartupFailed(result.error.code, result.error.message, {
      phase: 'local-db:ensure-ready',
    });
  }
}

/** Preserve the first concrete main-process startup failure for the waiting restart command. */
export function markDesktopDevStartupFailed(
  code: string,
  message: string,
  detail?: Record<string, unknown>,
): void {
  if (startupSettled) return;
  startupSettled = true;
  const failure = { code, message, ...(detail ? { detail } : {}) };
  updateTrackedInstance('failed', failure);
  updateExternalStartupStatus('failed', failure);
  publishDesktopStartupResult(false);
}
