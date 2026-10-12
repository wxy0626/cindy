/**
 * 从仍存在的伙伴 Home 恢复缺失的 SQLite 索引。
 *
 * 旧版本曾把伙伴目录放在账号 owner 下，后来共享库重建时只恢复了会话与供应商，
 * 伙伴目录本身并没有被删除，只是 `bot_profiles` 索引断了。本模块只做两件事：
 * 把现存 Home 合并到本机共享目录，再为没有索引的 Home 补 Profile 记录；
 * 对有原生历史文件证据的伙伴恢复 canonical session。不会覆盖已有文件或删除旧目录。
 */
import { app } from 'electron';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

import type { DbClient } from './client/DbClient.js';
import { machineSharedOwnerDirectories, machineSharedUserDataPath } from '../machineSharedStorage.js';
import { createLogger } from '../logger.js';
import { normalizeBotModelChain, type BotModelRoute } from '../../shared/botModelChain.js';
import { writeBotProfileFolder } from '../maker-ipc/botProfileFolder.js';

const log = createLogger('localDb/botProfileRecovery');
const BOT_ID_RE = /^[a-z0-9][a-z0-9_-]*$/;

interface BotHomeCandidate {
  id: string;
  source: string;
  modifiedAt: number;
}

interface BotHomeSnapshot {
  identitySource: string;
  userContextSource: string;
  capabilities: Record<string, unknown>;
}

interface CanonicalRecoveryEvidence {
  botId: string;
  title: string;
  sessionId: string;
  nativeFileName: string;
  model: string;
  providerId: string;
  effort: string;
  permissionMode: 'auto' | 'ask' | 'bypassPermissions';
}

/**
 * 这里只登记已经从本机 Pi 运行日志和原生 JSONL 双重确认过的证据。
 * 没有证据的伙伴不会凭空生成 canonical session。
 */
const CANONICAL_RECOVERY_EVIDENCE: readonly CanonicalRecoveryEvidence[] = [
  {
    botId: 'bot_1789060254674_afk845',
    title: 'RPG 地图玩法策划',
    sessionId: '4e6f16e0-e26c-4795-ae68-38f496fc3448',
    nativeFileName: '2026-09-11T08-35-30-012Z_01a08f9b-885c-787c-8872-fd7d2b5149e9.jsonl',
    model: 'z-ai/glm-5.3-flash',
    providerId: 'xd',
    effort: 'max',
    permissionMode: 'bypassPermissions',
  },
];

const RECOVERY_FALLBACK_ROUTES: readonly BotModelRoute[] = [
  { harness: 'pi', providerId: 'xd', model: 'z-ai/glm-5.3-flash', effort: 'max', fastMode: false },
  { harness: 'pi', providerId: 'sub2', model: 'gpt-5.6-luna', effort: 'max', fastMode: false },
  { harness: 'pi', providerId: 'anthropic-api', model: 'claude-opus-5', effort: 'max', fastMode: false },
  { harness: 'pi', providerId: 'xai-api', model: 'grok-4.6', effort: 'high', fastMode: false },
];

async function readDirectory(pathname: string): Promise<import('node:fs').Dirent[]> {
  try {
    return await fs.readdir(pathname, { withFileTypes: true });
  } catch {
    return [];
  }
}

async function isUsableBotHome(home: string): Promise<boolean> {
  try {
    const soul = (await fs.readFile(path.join(home, 'SOUL.md'), 'utf8')).trim();
    return soul.length > 0;
  } catch {
    return false;
  }
}

async function discoverBotHomes(): Promise<Map<string, BotHomeCandidate>> {
  const roots = new Set<string>([
    ...machineSharedOwnerDirectories().map((ownerRoot) => path.join(ownerRoot, 'bots')),
    path.join(app.getPath('userData'), 'bots'),
    path.join(machineSharedUserDataPath(), 'bots'),
  ]);
  const found = new Map<string, BotHomeCandidate>();
  for (const root of roots) {
    for (const entry of await readDirectory(root)) {
      if (!entry.isDirectory() || !BOT_ID_RE.test(entry.name)) continue;
      const source = path.join(root, entry.name);
      if (!(await isUsableBotHome(source))) continue;
      let modifiedAt = 0;
      try {
        modifiedAt = (await fs.stat(path.join(source, 'SOUL.md'))).mtimeMs;
      } catch {
        // SOUL.md 已通过上面的检查，时间读取失败时仍保留候选。
      }
      const current = found.get(entry.name);
      if (!current || modifiedAt > current.modifiedAt) {
        found.set(entry.name, { id: entry.name, source, modifiedAt });
      }
    }
  }
  return found;
}

async function mergeMissingTree(source: string, target: string): Promise<void> {
  let sourceStat;
  try {
    sourceStat = await fs.lstat(source);
  } catch {
    return;
  }
  if (sourceStat.isSymbolicLink()) return;
  if (sourceStat.isDirectory()) {
    await fs.mkdir(target, { recursive: true });
    for (const entry of await readDirectory(source)) {
      await mergeMissingTree(path.join(source, entry.name), path.join(target, entry.name));
    }
    return;
  }
  if (!sourceStat.isFile()) return;
  try {
    await fs.access(target);
  } catch {
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.copyFile(source, target);
  }
}

async function materializeSharedHomes(candidates: Map<string, BotHomeCandidate>): Promise<void> {
  const targetRoot = path.join(machineSharedUserDataPath(), 'bots');
  for (const candidate of candidates.values()) {
    const target = path.join(targetRoot, candidate.id);
    if (path.resolve(target) === path.resolve(candidate.source)) continue;
    try {
      await mergeMissingTree(candidate.source, target);
    } catch (error) {
      log.warn('failed to merge Bot Home into machine-shared storage', {
        botId: candidate.id,
        source: candidate.source,
        error: String(error),
      });
    }
  }
}

async function readJsonObject(filePath: string): Promise<Record<string, unknown>> {
  try {
    const parsed: unknown = JSON.parse(await fs.readFile(filePath, 'utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

async function readSkillNames(home: string): Promise<string[]> {
  const skills = await readDirectory(path.join(home, 'skills'));
  return skills.filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
}

function hasOwn(record: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, key);
}

function mergeMissingCapabilities(
  botId: string,
  current: Record<string, unknown>,
): Record<string, unknown> {
  const next: Record<string, unknown> = { ...current };
  const existingChain = normalizeBotModelChain(next.modelChain, next);
  const chain = existingChain.length > 0 ? existingChain : [...RECOVERY_FALLBACK_ROUTES];
  const primary = chain[0]!;
  const defaults: Record<string, unknown> = {
    permissions: botId === 'bot_1789060254674_afk845' ? 'trusted' : 'auto',
    modelChain: chain,
    modelChainOverride: null,
    harness: primary.harness,
    model: primary.model,
    providerId: primary.providerId,
    effort: primary.effort,
    fastMode: primary.fastMode,
    memory: true,
    skillMode: 'allowlist',
    skillsExcluded: [],
    toolsetMode: 'allowlist',
    toolsets: [],
    mcpMode: 'allowlist',
    mcpServers: [],
  };
  for (const [key, value] of Object.entries(defaults)) {
    if (!hasOwn(next, key) || next[key] === undefined || next[key] === '') next[key] = value;
  }
  return next;
}

function inferDisplayName(botId: string, identitySource: string): string {
  if (/RPG\s+地图创作中的玩法策划/u.test(identitySource)) return 'RPG 地图玩法策划';
  const match = identitySource.match(/(?:你是|我是)\s*([^，。,.\n!?！？]{1,80})/u);
  const inferred = match?.[1]?.trim();
  return inferred || botId;
}

async function readBotHomeSnapshot(home: string): Promise<BotHomeSnapshot | null> {
  let identitySource = '';
  try {
    identitySource = (await fs.readFile(path.join(home, 'SOUL.md'), 'utf8')).trim();
  } catch {
    return null;
  }
  if (!identitySource) return null;
  const fileCapabilities = await readJsonObject(path.join(home, 'config.json'));
  const skills = await readSkillNames(home);
  const userContextSource = await fs
    .readFile(path.join(home, 'memories', 'USER.md'), 'utf8')
    .catch(() => '');
  const capabilities: Record<string, unknown> = {
    permissions: 'auto',
    ...fileCapabilities,
    ...(skills.length > 0 && !Array.isArray(fileCapabilities.skills) ? { skills } : {}),
    ...(userContextSource.trim() ? { userContextSource } : {}),
  };
  return { identitySource, userContextSource, capabilities };
}

async function readNativeSessionEvidence(
  evidence: CanonicalRecoveryEvidence,
): Promise<{ sdkSessionId: string; createdAt: number; updatedAt: number } | null> {
  const sessionPath = path.join(
    app.getPath('userData'),
    'pi-agent-home',
    'sessions',
    evidence.nativeFileName,
  );
  try {
    const stat = await fs.stat(sessionPath);
    const firstLine = (await fs.readFile(sessionPath, 'utf8')).split(/\r?\n/u).find(Boolean);
    if (!firstLine) return null;
    const first = JSON.parse(firstLine) as { type?: unknown; id?: unknown; timestamp?: unknown; cwd?: unknown };
    if (
      first.type !== 'session' ||
      typeof first.id !== 'string' ||
      typeof first.timestamp !== 'string' ||
      typeof first.cwd !== 'string' ||
      !first.cwd.includes(`${path.sep}bots${path.sep}${evidence.botId}${path.sep}workspace`)
    ) {
      return null;
    }
    const createdAt = Date.parse(first.timestamp);
    if (!Number.isFinite(createdAt)) return null;
    return {
      sdkSessionId: sessionPath,
      createdAt,
      updatedAt: Math.max(createdAt, Math.round(stat.mtimeMs)),
    };
  } catch {
    return null;
  }
}

function nativeMessageContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return JSON.stringify(content ?? null);
  const text = content
    .filter((part): part is { type?: unknown; text?: unknown } => !!part && typeof part === 'object')
    .filter((part) => part.type === 'text' && typeof part.text === 'string')
    .map((part) => part.text)
    .join('');
  return text || JSON.stringify(content);
}

async function restoreNativeMessages(client: DbClient, evidence: CanonicalRecoveryEvidence, sessionId: string): Promise<number> {
  const sessionPath = path.join(app.getPath('userData'), 'pi-agent-home', 'sessions', evidence.nativeFileName);
  let lines: string[];
  try {
    lines = (await fs.readFile(sessionPath, 'utf8')).split(/\r?\n/u).filter(Boolean);
  } catch {
    return 0;
  }
  let restored = 0;
  for (const line of lines) {
    try {
      const item = JSON.parse(line) as {
        type?: unknown;
        id?: unknown;
        timestamp?: unknown;
        message?: { role?: unknown; content?: unknown };
      };
      if (item.type !== 'message' || typeof item.id !== 'string' || !item.message) continue;
      const role = item.message.role;
      const normalizedRole =
        role === 'user' || role === 'assistant' || role === 'thinking' || role === 'tool_use' || role === 'tool_result'
          ? role
          : null;
      if (!normalizedRole) continue;
      const createdAt = typeof item.timestamp === 'string' ? Date.parse(item.timestamp) : NaN;
      if (!Number.isFinite(createdAt)) continue;
      const clientId = `pi-recovery:${item.id}`;
      const id = `pi-recovery:${crypto.createHash('sha256').update(`${sessionId}:${item.id}`).digest('hex')}`;
      const result = await client.exec(
        `INSERT INTO messages
         (id, client_id, session_id, role, content, tool_use_id, agent_meta, agent_kind, created_at)
         VALUES (?, ?, ?, ?, ?, NULL, NULL, 'pi', ?)
         ON CONFLICT(session_id, client_id) DO NOTHING`,
        [id, clientId, sessionId, normalizedRole, nativeMessageContent(item.message.content), createdAt],
      );
      restored += result.changes;
    } catch {
      // 单条原生记录损坏时跳过，不能阻断整个伙伴恢复。
    }
  }
  return restored;
}

async function recoverCanonicalSession(
  client: DbClient,
  botId: string,
  now: number,
): Promise<{ created: boolean; messages: number }> {
  const evidence = CANONICAL_RECOVERY_EVIDENCE.find((item) => item.botId === botId);
  if (!evidence) return { created: false, messages: 0 };
  const native = await readNativeSessionEvidence(evidence);
  if (!native) return { created: false, messages: 0 };
  const existingLink = await client.queryOne<{ sessionId: string }>(
    "SELECT session_id AS sessionId FROM bot_session_links WHERE bot_id = ? AND role = 'canonical' AND archived_at IS NULL LIMIT 1",
    [botId],
  );
  if (existingLink) {
    return existingLink.sessionId === evidence.sessionId
      ? { created: false, messages: await restoreNativeMessages(client, evidence, evidence.sessionId) }
      : { created: false, messages: 0 };
  }
  const occupied = await client.queryOne<{ source: string }>('SELECT source FROM sessions WHERE id = ?', [evidence.sessionId]);
  if (occupied && occupied.source !== 'bot') return { created: false, messages: 0 };
  const homeWorkspace = path.join(machineSharedUserDataPath(), 'bots', botId, 'workspace');
  await fs.mkdir(homeWorkspace, { recursive: true });
  if (!occupied) {
    await client.exec(
      `INSERT INTO sessions
       (id, title, working_dir, workspace_kind, model, effort, permission_mode, status,
        sdk_session_id, total_token_usage, total_cost_usd, context_tokens, context_window,
        fast_mode, plan_mode_enabled, cleared_at, pinned_at, user_send_at, agent_kind,
        orca_role, parent_session_id, forked_at_message_id, worktree_path, extra_dirs,
        remote_host_id, provider_id, source, created_at, updated_at)
       VALUES (?, ?, ?, 'project', ?, ?, ?, 'active', ?, 0, 0, 0, 0, 0, 0, NULL, NULL, NULL,
        'pi', NULL, NULL, NULL, NULL, '[]', NULL, ?, 'bot', ?, ?)`,
      [
        evidence.sessionId,
        evidence.title,
        homeWorkspace,
        evidence.model,
        evidence.effort,
        evidence.permissionMode,
        native.sdkSessionId,
        evidence.providerId,
        native.createdAt,
        native.updatedAt,
      ],
    );
  }
  await client.exec(
    `INSERT INTO bot_session_links
     (id, bot_id, session_id, profile_version, role, route_key, created_at, archived_at)
     VALUES (?, ?, ?, 1, 'canonical', NULL, ?, NULL)
     ON CONFLICT(session_id) DO NOTHING`,
    [`${botId}:${evidence.sessionId}`, botId, evidence.sessionId, now],
  );
  await client.exec(
    'UPDATE bot_profiles SET canonical_session_id = ?, updated_at = ? WHERE id = ? AND canonical_session_id IS NULL',
    [evidence.sessionId, now, botId],
  );
  if (await client.queryOne<{ id: string }>(
    'SELECT id FROM bot_lifecycle_events WHERE id = ?',
    [`${botId}:canonical-recovered:${evidence.sessionId}`],
  ) === undefined) {
    await client.exec(
      `INSERT INTO bot_lifecycle_events
       (id, bot_id, session_id, event_type, payload_json, created_at)
       VALUES (?, ?, ?, 'canonical-recovered', ?, ?)`,
      [
        `${botId}:canonical-recovered:${evidence.sessionId}`,
        botId,
        evidence.sessionId,
        JSON.stringify({ evidence: evidence.nativeFileName, providerId: evidence.providerId }),
        now,
      ],
    );
  }
  return { created: true, messages: await restoreNativeMessages(client, evidence, evidence.sessionId) };
}

/**
 * 启动时补齐缺失索引。返回本次实际创建的 Profile 数量，便于诊断日志和测试。
 */
export async function recoverMissingBotProfilesFromHomes(client: DbClient): Promise<number> {
  const candidates = await discoverBotHomes();
  if (candidates.size === 0) return 0;
  await materializeSharedHomes(candidates);

  const existingRows = await client.query<{ id: string }>('SELECT id FROM bot_profiles');
  const existing = new Set(existingRows.map((row) => row.id));
  let recovered = 0;
  const now = Date.now();
  for (const id of candidates.keys()) {
    const home = path.join(machineSharedUserDataPath(), 'bots', id);
    const snapshot = await readBotHomeSnapshot(home);
    if (!snapshot) continue;
    const capabilities = mergeMissingCapabilities(id, snapshot.capabilities);
    if (!existing.has(id)) {
      try {
        await client.tx('bots.createProfile', {
          id,
          displayName: inferDisplayName(id, snapshot.identitySource),
          description: '',
          avatar: '🤖',
          avatarColor: 'violet',
          identitySource: snapshot.identitySource,
          capabilitiesJson: JSON.stringify(capabilities),
          now,
        });
        existing.add(id);
        recovered += 1;
      } catch (error) {
        const code = error && typeof error === 'object' && 'code' in error
          ? String((error as { code?: unknown }).code)
          : '';
        if (!/ALREADY_EXISTS|UNIQUE|constraint/i.test(code + ' ' + String(error))) {
          log.warn('failed to recover missing Bot Profile index', { botId: id, error: String(error) });
        }
      }
    }
    if (existing.has(id)) {
      const version = await client.queryOne<{ identitySource: string; capabilitiesJson: string }>(
        'SELECT identity_source AS identitySource, capabilities_json AS capabilitiesJson FROM bot_profile_versions WHERE bot_id = ? ORDER BY version DESC LIMIT 1',
        [id],
      );
      if (version) {
        let stored: Record<string, unknown> = {};
        try {
          const parsed = JSON.parse(version.capabilitiesJson) as unknown;
          if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) stored = parsed as Record<string, unknown>;
        } catch {
          stored = {};
        }
        // 数据库快照是用户已经明确保存过的值；Home 只提供数据库缺失的旧字段。
        const completed = mergeMissingCapabilities(id, { ...snapshot.capabilities, ...stored });
        if (JSON.stringify(completed) !== JSON.stringify(stored)) {
          await client.exec(
            'UPDATE bot_profile_versions SET capabilities_json = ? WHERE bot_id = ? AND version = (SELECT current_version FROM bot_profiles WHERE id = ?)',
            [JSON.stringify(completed), id, id],
          );
        }
        await writeBotProfileFolder(machineSharedUserDataPath(), id, { config: completed });
      }
      const canonical = await recoverCanonicalSession(client, id, now);
      if (canonical.created || canonical.messages > 0) {
        log.info('recovered Bot canonical session from native evidence', {
          botId: id,
          created: canonical.created,
          messages: canonical.messages,
        });
      }
    }
  }
  if (recovered > 0) {
    log.info('recovered missing Bot Profile indexes from existing homes', { recovered });
  }
  return recovered;
}
