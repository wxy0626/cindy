/**
 * 登录账号边界上的本地项目同步。
 *
 * 这里只处理数据库白名单快照：不复制本地文件、不读取凭证、不复制 provider
 * runtime 绑定。所有快照都在 main 进程生成，renderer 只能提交共享策略。
 */

import { createHash } from 'node:crypto';

import type { DbClient } from './localDb/client/DbClient.js';
import type {
  AccountImportLocalProjectsArgs,
  LocalProjectImportMessageRow,
  LocalProjectImportRecentWorkdirRow,
  LocalProjectImportSessionRow,
  LocalProjectImportAliasRow,
  LocalProjectImportSubagentRunRow,
} from './localDb/client/tx/types.js';
import type { LocalProjectSyncOptions } from '../shared/localProjectSync.js';
import { normalizeProjectKey } from '../shared/projectKeys.js';

export interface LocalProjectSyncSnapshot {
  /** 快照来源账号，仅用于生命周期校验，不进入目标数据库。 */
  sourceUserId: string;
  payload: AccountImportLocalProjectsArgs;
}

export interface CaptureLocalProjectSyncInput {
  sourceUserId: string;
  policy: LocalProjectSyncOptions;
}

type SessionDbRow = Record<string, unknown> & { id: string };

/**
 * 从当前 owner 的 DbClient 生成一次性白名单快照，并为目标账号生成稳定的隔离 ID。
 * 重要安全边界：projectFiles 只保留本地路径，绝不打开或复制路径指向的文件。
 */
export async function captureLocalProjectSyncSnapshot(
  client: DbClient,
  input: CaptureLocalProjectSyncInput,
): Promise<LocalProjectSyncSnapshot | null> {
  const { policy } = input;
  if (!Object.values(policy).some(Boolean)) return null;

  const sessionRows = await readSessions(client, policy);
  if (sessionRows.length === 0 && !policy.projectList) return null;

  const sessionIdMap = new Map<string, string>(
    sessionRows.map((row) => [
      row.id,
      stableLocalProjectSyncId(input.sourceUserId, 'session', row.id),
    ]),
  );
  const importedSessions = sessionRows.map((row) =>
    mapSession(row, sessionIdMap, input.sourceUserId, policy),
  );
  const importedMessages =
    policy.projectConversation || policy.independentConversations
      ? await readMessages(client, input.sourceUserId, sessionIdMap, policy)
      : [];
  const projectKeys = new Set(
    sessionRows
      .filter((row) => String(row.workspace_kind) === 'project' && row.working_dir != null)
      .map((row) => normalizeProjectKey(String(row.working_dir)))
      .filter((key): key is string => key != null),
  );
  const importedRecentWorkdirs = policy.projectList
    ? await readRecentWorkdirs(client, projectKeys)
    : [];
  const importedAliases = policy.projectList
    ? await readProjectAliases(client, projectKeys)
    : [];
  const importedSubagentRuns = policy.projectRuntimeRecords
    ? await readSubagentRuns(client, input.sourceUserId, sessionIdMap)
    : [];

  if (
    importedSessions.length === 0 &&
    importedMessages.length === 0 &&
    importedRecentWorkdirs.length === 0 &&
    importedAliases.length === 0 &&
    importedSubagentRuns.length === 0
  ) {
    return null;
  }

  return {
    sourceUserId: input.sourceUserId,
    payload: {
      sessions: importedSessions,
      messages: importedMessages,
      recentWorkdirs: importedRecentWorkdirs,
      projectAliases: importedAliases,
      subagentRuns: importedSubagentRuns,
    },
  };
}

/** 生成只在共享数据库中使用的稳定 ID，避免账号来回切换产生重复记录。 */
export function stableLocalProjectSyncId(
  sourceUserId: string,
  kind: string,
  sourceId: string,
): string {
  const digest = createHash('sha256')
    .update(
      ['local-project-sync:v1', sourceUserId, kind, sourceId].join('\0'),
      'utf8',
    )
    .digest('hex');
  return 'shared:' + digest;
}

/** 读取策略允许的会话；远程项目、已删除会话和无项目路径会被排除。 */
async function readSessions(
  client: DbClient,
  policy: LocalProjectSyncOptions,
): Promise<SessionDbRow[]> {
  const clauses: string[] = [];
  if (
    policy.projectConversation ||
    policy.projectFiles ||
    policy.projectList ||
    policy.projectRuntimeRecords
  ) {
    clauses.push(
      "(workspace_kind = 'project' AND working_dir IS NOT NULL AND remote_host_id IS NULL)",
    );
  }
  if (policy.independentConversations) {
    clauses.push("(workspace_kind = 'dialogue' AND remote_host_id IS NULL)");
  }
  if (clauses.length === 0) return [];
  return client.query<SessionDbRow>(
    `SELECT * FROM sessions
      WHERE status != 'deleted'
        AND source != 'shared'
        AND (${clauses.join(' OR ')})
      ORDER BY created_at ASC, id ASC`,
  );
}

/** 读取并重建消息 ID；消息正文只有在对应会话共享开关开启时才进入快照。 */
async function readMessages(
  client: DbClient,
  sourceUserId: string,
  sessionIdMap: Map<string, string>,
  policy: LocalProjectSyncOptions,
): Promise<LocalProjectImportMessageRow[]> {
  const sessionIds = [...sessionIdMap.keys()];
  const allowed = new Set(
    (await client.query<{ id: string; workspaceKind: string }>(
      `SELECT id, workspace_kind AS workspaceKind FROM sessions WHERE id IN (${sessionIds.map(() => '?').join(',') || 'NULL'})`,
      sessionIds,
    ))
      .filter((row) =>
        row.workspaceKind === 'project' ? policy.projectConversation : policy.independentConversations,
      )
      .map((row) => row.id),
  );
  if (allowed.size === 0) return [];
  const rows = await client.query<Record<string, unknown>>(
    `SELECT id, client_id AS clientId, session_id AS sessionId, role, content,
            tool_use_id AS toolUseId, agent_meta AS agentMeta, agent_kind AS agentKind,
            created_at AS createdAt, rewind_at AS rewindAt
       FROM messages
      WHERE session_id IN (${[...allowed].map(() => '?').join(',')})
      ORDER BY created_at ASC, id ASC`,
    [...allowed],
  );
  const newMessageIds = new Map(
    rows.map((row) => [
      String(row.id),
      stableLocalProjectSyncId(sourceUserId, 'message', String(row.id)),
    ]),
  );
  return rows.map((row) => ({
    id: newMessageIds.get(String(row.id))!,
    clientId: String(row.clientId),
    sessionId: sessionIdMap.get(String(row.sessionId))!,
    role: String(row.role),
    content: String(row.content),
    // provider/SDK 元信息可能含 native id 或凭证关联，跨账号同步时清空。
    toolUseId: null,
    agentMeta: null,
    agentKind: row.agentKind == null ? null : String(row.agentKind),
    createdAt: Number(row.createdAt),
    rewindAt: row.rewindAt == null ? null : Number(row.rewindAt),
  }));
}

/** 将源 session 映射为无 provider 运行绑定的目标账号记录。 */
function mapSession(
  row: SessionDbRow,
  sessionIdMap: Map<string, string>,
  sourceUserId: string,
  policy: LocalProjectSyncOptions,
): LocalProjectImportSessionRow {
  const project = String(row.workspace_kind) === 'project';
  const includeConversation = project ? policy.projectConversation : policy.independentConversations;
  const includeProjectPath =
    project && (policy.projectFiles || policy.projectList || policy.projectRuntimeRecords);
  // 关闭项目对话后仍允许同步项目入口，但不能把源账号的会话详情带过去。
  const includeSessionDetails = !project || includeConversation;
  return {
    id: sessionIdMap.get(row.id)!,
    title: includeSessionDetails ? String(row.title ?? 'New Maker') : 'Shared project',
    // 会话共享与路径共享独立控制；关闭项目文件/列表/运行记录时不泄露本地路径。
    workingDir: includeProjectPath && row.working_dir != null ? String(row.working_dir) : null,
    workspaceKind: project ? 'project' : 'dialogue',
    worktreePath: null,
    model: String(row.model ?? 'claude-sonnet-4-6'),
    effort: String(row.effort ?? 'medium'),
    permissionMode: String(row.permission_mode ?? 'ask'),
    providerId: null,
    status: row.status === 'archived' ? 'archived' : 'active',
    sdkSessionId: null,
    totalTokenUsage: 0,
    totalCostUsd: 0,
    totalCostAmount: 0,
    totalCostCurrency: null,
    totalCostIsApproximate: false,
    contextTokens: 0,
    contextWindow: Number(row.context_window ?? 0),
    fastMode: Boolean(row.fast_mode),
    planModeEnabled: Boolean(row.plan_mode_enabled),
    clearedAt:
      includeSessionDetails && row.cleared_at != null ? Number(row.cleared_at) : null,
    pinnedAt: includeSessionDetails && row.pinned_at != null ? Number(row.pinned_at) : null,
    summary: includeSessionDetails && row.summary != null ? String(row.summary) : null,
    userSendAt:
      includeSessionDetails && row.user_send_at != null ? Number(row.user_send_at) : null,
    agentKind: String(row.agent_kind ?? 'cc'),
    orcaRole: null,
    parentSessionId:
      row.parent_session_id != null && sessionIdMap.has(String(row.parent_session_id))
        ? sessionIdMap.get(String(row.parent_session_id))!
        : null,
    forkedAtMessageId:
      includeSessionDetails && row.forked_at_message_id != null
        ? stableLocalProjectSyncId(
            sourceUserId,
            'message',
            String(row.forked_at_message_id),
          )
        : null,
    source: 'shared',
    feishuOpenId: null,
    feishuBotAppId: null,
    imBotContextId: null,
    imUserId: null,
    usedProjectContext: false,
    codexHistoryHasProductPrompt: null,
    codexPlanJson: null,
    extraDirs: '[]',
    writableDirs: '[]',
    remoteHostId: null,
    activeTurnStartedAt: null,
    activeTurnPid: null,
    lastTurnEndedAt: null,
    listPreview:
      includeSessionDetails && row.list_preview != null ? String(row.list_preview) : null,
    listPreviewRole:
      includeSessionDetails && row.list_preview_role != null
        ? String(row.list_preview_role)
        : null,
    listMessageCount:
      includeSessionDetails && row.list_message_count != null
        ? Number(row.list_message_count)
        : 0,
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}

/** 共享项目列表时只传递目录索引，目标库已有记录不会被快照层覆盖。 */
async function readRecentWorkdirs(
  client: DbClient,
  projectKeys: ReadonlySet<string>,
): Promise<LocalProjectImportRecentWorkdirRow[]> {
  const rows = await client.query<LocalProjectImportRecentWorkdirRow>(
    `SELECT path, last_used_at AS lastUsedAt
       FROM recent_workdirs
      WHERE EXISTS (
        SELECT 1 FROM sessions
         WHERE sessions.workspace_kind = 'project'
           AND sessions.working_dir = recent_workdirs.path
           AND sessions.remote_host_id IS NULL
           AND sessions.status != 'deleted'
           AND sessions.source != 'shared'
      )
      ORDER BY last_used_at DESC, path ASC`,
  );
  return rows.filter((row) => projectKeys.has(normalizeProjectKey(row.path) ?? ''));
}

/** 共享项目别名时保留别名文本，不传播账号凭证或云端配置。 */
async function readProjectAliases(
  client: DbClient,
  projectKeys: ReadonlySet<string>,
): Promise<LocalProjectImportAliasRow[]> {
  const rows = await client.query<LocalProjectImportAliasRow>(
    `SELECT project_key AS projectKey, alias, updated_at AS updatedAt
       FROM project_aliases
      WHERE project_key LIKE 'local:%'
      ORDER BY project_key ASC`,
  );
  return rows.filter((row) => {
    const key = normalizeProjectKey(row.projectKey);
    return key != null && projectKeys.has(key);
  });
}

/** 共享安全的子任务结果，清掉 native/provider runtime id。 */
async function readSubagentRuns(
  client: DbClient,
  sourceUserId: string,
  sessionIdMap: Map<string, string>,
): Promise<LocalProjectImportSubagentRunRow[]> {
  const sessionIds = [...sessionIdMap.keys()];
  if (sessionIds.length === 0) return [];
  // subagent_runs 是较新版本才有的可选表；旧账号库仍应完成项目会话同步。
  const table = await client.queryOne<{ name: string }>(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'subagent_runs' LIMIT 1",
  );
  if (!table) return [];
  const rows = await client.query<Record<string, unknown>>(
    `SELECT id, session_id AS sessionId, provider, logical_agent_id AS logicalAgentId,
            status, title, description, summary, returned_result AS returnedResult,
            returned_result_empty AS returnedResultEmpty, returned_result_truncated AS returnedResultTruncated,
            model, reasoning_effort AS reasoningEffort, total_tokens AS totalTokens,
            tool_uses AS toolUses, duration_ms AS durationMs, cost_usd AS costUsd,
            started_at AS startedAt, updated_at AS updatedAt, ended_at AS endedAt,
            rewind_at AS rewindAt, deleted_at AS deletedAt
       FROM subagent_runs
      INNER JOIN sessions ON sessions.id = subagent_runs.session_id
      WHERE sessions.workspace_kind = 'project'
        AND sessions.status != 'deleted'
        AND sessions.source != 'shared'
        AND subagent_runs.session_id IN (${sessionIds.map(() => '?').join(',')})
      ORDER BY subagent_runs.started_at ASC, subagent_runs.id ASC`,
    sessionIds,
  );
  return rows.flatMap((row) => {
    const sessionId = sessionIdMap.get(String(row.sessionId));
    if (!sessionId) return [];
    return [{
      id: stableLocalProjectSyncId(sourceUserId, 'subagent-run', String(row.id)),
      sessionId,
      provider: String(row.provider),
      logicalAgentId: String(row.logicalAgentId),
      parentToolUseId: null,
      aliases: '[]',
      providerRunIds: '[]',
      status: row.status === 'completed' || row.status === 'failed' || row.status === 'stopped' ? String(row.status) : 'completed',
      title: row.title == null ? null : String(row.title),
      description: row.description == null ? null : String(row.description),
      summary: row.summary == null ? null : String(row.summary),
      returnedResult: row.returnedResult == null ? null : String(row.returnedResult),
      returnedResultEmpty: row.returnedResultEmpty == null ? null : Number(row.returnedResultEmpty),
      returnedResultTruncated: row.returnedResultTruncated == null ? null : Number(row.returnedResultTruncated),
      model: row.model == null ? null : String(row.model),
      reasoningEffort: row.reasoningEffort == null ? null : String(row.reasoningEffort),
      totalTokens: row.totalTokens == null ? null : Number(row.totalTokens),
      toolUses: row.toolUses == null ? null : Number(row.toolUses),
      durationMs: row.durationMs == null ? null : Number(row.durationMs),
      costUsd: row.costUsd == null ? null : Number(row.costUsd),
      capabilities: '{}',
      activity: '[]',
      startedAt: Number(row.startedAt),
      updatedAt: Number(row.updatedAt),
      endedAt: row.endedAt == null ? null : Number(row.endedAt),
      rewindAt: row.rewindAt == null ? null : Number(row.rewindAt),
      deletedAt: row.deletedAt == null ? null : Number(row.deletedAt),
    }];
  });
}
