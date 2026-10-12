import { normalizeBotModelChain, readBotTaskModelOverride, type BotModelRoute } from '../../../shared/botModelChain.js';
import { createHash, randomUUID } from 'node:crypto';
import type { RemoteActionDescriptor, RemoteActionInvokeRequest, RemoteActionInvokeResponse, RemoteLocalizedText, RemoteResource } from '@cindy/device-link';
import type { getBotRemoteSettingsSource } from './bots.js';
import { botRemoteResourceFromSource } from './botRemoteResourceProjection.js';
import { RemoteResourceRegistryError, type RemoteResourceHostContext } from '../../device-link/remoteResourceRegistry.js';
import { throwIpcError } from '../../utils/ipcValidate.js';

type Settings = Awaited<ReturnType<typeof getBotRemoteSettingsSource>>;
type Operation = 'profile' | 'models' | 'memory' | 'permissions' | 'restart' | 'delete' | 'resume';
type Grant = { owner: string; controller: string; botId: string; version: number; revision: string; operation: Operation; expires: number };
type BoundGrant = { owner: string; controller: string; ref: NonNullable<RemoteActionInvokeRequest['resourceRef']>; expires: number; check: () => Promise<void>; run: (request: RemoteActionInvokeRequest) => Promise<RemoteActionInvokeResponse> };
export interface BotRemoteSettingsDeps {
  owner(): string;
  assertOwner(owner: string): void;
  read(botId: string): Promise<Settings>;
  update(input: Record<string, unknown>, version: number): Promise<unknown>;
  lifecycle(botId: string, operation: 'restart' | 'delete' | 'resume', confirmName: string | undefined, guard: () => Promise<void>): Promise<{ warnings?: string[] }>;
  skills(botId: string): Promise<Array<{ slug: string; name: string; description: string; updatedAt: string | number }>>;
  directHistory?(botId: string): Promise<string>;
  now?: () => number;
}
const text = (fallback: string, cn: string): RemoteLocalizedText =>
  ({ fallback, translations: { 'zh-CN': cn } });
const copy = {
  profile: text('Profile & Personality', '资料与性格'),
  name: text('Name', '名字'),
  description: text('About', '简介'),
  identity: text('Personality', '性格'),
  models: text('Models', '模型'),
  followsDefault: text('Follow app default', '跟随应用默认'),
  taskModel: text('Task Model', '任务模型'),
  taskFollowsPrimary: text('Inherit Primary Model', '继承主模型'),
  memory: text('Memory', '记忆'),
  memoryEnabled: text('Remember Things About Me', '记住与我有关的事'),
  userContext: text('What You Know About Me', '关于我的记忆'),
  permissions: text('Operation Permissions', '操作权限'),
  ask: text('Ask Before Acting', '操作前询问'),
  auto: text('Auto Approval', '自动审批'),
  trusted: text('Full Access', '完全访问'),
  permissionWarning: text('Changing permissions affects future operations. Full Access allows commands and file changes without asking. Existing connection restrictions still apply.', '权限变更影响后续操作。完全访问允许执行命令和修改文件而不再询问，已有连接限制仍然有效。'),
  restart: text('Restart Teammate', '重启伙伴'),
  restartBody: text('Stop current work and rebuild context on your next message. History, memory and files stay. Independent tasks continue; queued input stays paused.', '停止当前工作，下一条消息重建上下文。记录、记忆和文件保留，独立任务继续，排队输入保持暂停。'),
  delete: text('Delete Teammate', '删除伙伴'),
  deleteBody: text('Permanently delete this teammate’s profile, memory, skills and workspace. Task history and independent worktrees are retained. Type the full name to delete.', '永久删除伙伴的资料、记忆、技能和工作区。任务记录和独立 worktree 保留。输入完整名字后删除。'),
  resume: text('Resume Teammate', '恢复伙伴'),
  resumeBody: text('Your teammate starts taking messages and background work again. History, memory and files are unchanged; automations you paused yourself stay paused.', '恢复后伙伴重新接收消息和后台工作。记录、记忆和文件不变，你手动暂停的自动化仍保持暂停。'),
  save: text('Save Changes', '保存更改'),
  saved: text('Teammate settings saved', '伙伴设置已保存'),
  restarted: text('Teammate restarted; send a message to continue', '伙伴已重启，发送消息即可继续'),
  deleted: text('Teammate deleted', '伙伴已删除'),
  warning: text('Operation completed with cleanup warnings. Check this teammate on your computer.', '操作已完成，但清理有待检查。请在电脑上检查此伙伴。'),
};
// Name/avatar changes do not advance the runtime version. Include settings facts,
// while excluding chat activity so an arriving reply cannot invalidate a settings draft.
const settingsRevision = ({ source, ...settings }: Settings) => createHash('sha256').update(JSON.stringify([
  source.currentVersion, source.name, source.description, source.avatar, source.status, settings,
])).digest('hex');

/** Bounded, expiring, owner/controller/version-bound opaque actions. No raw IPC or filesystem grants. */
export function createBotRemoteSettingsResource(deps: BotRemoteSettingsDeps) {
  const grants = new Map<string, Grant>();
  const now = deps.now ?? Date.now;
  const bound = new Map<string, BoundGrant>();
  const submitting = new Set<string>();
  /** All module-specific actions, including routines, use this same opaque admission boundary.
   * The fixed inner action ids are display semantics only, never public mutation authority. */
  const bindResource = async (context: RemoteResourceHostContext, resource: RemoteResource,
    readRevision: () => Promise<string>, run: (request: RemoteActionInvokeRequest) => Promise<RemoteActionInvokeResponse>) => {
    const owner = deps.owner();
    deps.assertOwner(owner);
    const revision = resource.revision;
    if (await readRevision() !== revision) throwIpcError('PRECONDITION_FAILED', 'Resource changed while reading');
    deps.assertOwner(owner);
    const check = async () => {
      deps.assertOwner(owner);
      if (await readRevision() !== revision) throwIpcError('PRECONDITION_FAILED', 'Resource changed; refresh before retrying');
      deps.assertOwner(owner);
    };
    const ids: Record<string, string> = {};
    const actions = (resource.actions ?? []).map(action => {
      for (const [id, grant] of bound) if (grant.expires <= now()) bound.delete(id);
      while (bound.size >= 2048) bound.delete(bound.keys().next().value!);
      const id = randomUUID(); ids[action.id] = id;
      bound.set(id, { owner, controller: context.controllerDeviceId, ref: resource.ref, expires: now() + 15 * 60_000, check,
        run: request => {
          if (action.disabled) throwIpcError('PRECONDITION_FAILED', 'Action unavailable');
          return run({ ...request, actionId: action.id });
        } });
      return { ...action, id };
    });
    return { ...resource, actions, blocks: resource.blocks?.map(block => {
      const data = block.data && typeof block.data === 'object' ? block.data as Record<string, unknown> : {};
      return { ...block, data: { ...data, operationActions: ids,
        ...(typeof data.actionId === 'string' ? { actionId: ids[data.actionId] } : {}) } };
    }) };
  };
  const issue = (context: RemoteResourceHostContext, owner: string, settings: Settings, operation: Operation): string => {
    const { source } = settings;
    for (const [id, grant] of grants) if (grant.expires <= now()) grants.delete(id);
    while (grants.size >= 1024) grants.delete(grants.keys().next().value!);
    const id = randomUUID();
    grants.set(id, { owner, controller: context.controllerDeviceId, botId: source.id, version: source.currentVersion, revision: settingsRevision(settings), operation, expires: now() + 15 * 60_000 });
    return id;
  };
  const get = async (context: RemoteResourceHostContext, botId: string): Promise<RemoteResource> => {
    const owner = deps.owner();
    deps.assertOwner(owner);
    const settings = await deps.read(botId);
    deps.assertOwner(owner);
    const { source } = settings;
    const resource = botRemoteResourceFromSource(source);
    resource.revision = settingsRevision(settings);
    const actions: RemoteActionDescriptor[] = [];
    const form = (operation: Operation, fields: RemoteActionDescriptor['fields'], values: Record<string, unknown>) => {
      // A file-imported personality can exceed the portable editor's limit. Never expose a
      // truncated draft as editable: retaining the original is more important than a save button.
      if (Object.values(values).some(value => typeof value === 'string' && value.length > 12_000)) {
        return { id: operation, primitive: 'markdown', title: copy[operation], fallbackMarkdown: Object.values(values).filter(value => typeof value === 'string').join('\n\n').slice(0, 60_000) };
      }
      const id = issue(context, owner, settings, operation);
      const preparing = source.invitation && source.invitation.stage !== 'ready'
        && !(source.invitation.stage === 'avatar' && source.canonicalSessionId);
      actions.push({ id, label: copy[operation], fields,
        ...(operation === 'profile' && preparing ? { disabled: true } : {}),
        ...(operation === 'permissions' ? { confirmation: { title: copy.permissions, body: copy.permissionWarning, confirmLabel: copy.save } } : {}) });
      return { id: operation, primitive: 'form', title: copy[operation], fallbackMarkdown: operation === 'models' ? settings.modelChain.map(route => [route.model, route.providerId, route.harness, route.effort, `Fast: ${route.fastMode}`].filter(Boolean).join(' · ')).join('\n') : copy[operation].fallback, data: { actionId: id, values } };
    };
    resource.blocks = [
      form('profile', [{ id: 'name', kind: 'text', label: copy.name, required: true }, { id: 'description', kind: 'multiline', label: copy.description }, { id: 'identity', kind: 'multiline', label: copy.identity }], { name: source.name, description: source.description, identity: settings.identity }),
      form('memory', [{ id: 'memory', kind: 'toggle', label: copy.memoryEnabled }, { id: 'userContext', kind: 'multiline', label: copy.userContext }], { memory: settings.memory, userContext: settings.userContext }),
      form('permissions', [{ id: 'permissions', kind: 'select', label: copy.permissions, options: ['ask', 'auto', 'trusted'].map(value => ({ value, label: copy[value as 'ask' | 'auto' | 'trusted'] })) }], { permissions: settings.permissions }),
      form('models', [{ id: 'followsDefault', label: copy.followsDefault, kind: 'toggle' }, { id: 'modelChain', label: copy.models, kind: 'multiline' },
        { id: 'taskFollowsPrimary', label: copy.taskFollowsPrimary, kind: 'toggle' },
        { id: 'taskModel', label: copy.taskModel, kind: 'multiline' }],
        { followsDefault: settings.followsDefault, modelChain: JSON.stringify(settings.modelChain),
          taskFollowsPrimary: !settings.taskModelOverride,
          taskModel: JSON.stringify(settings.taskModelOverride ? [settings.taskModelOverride] : settings.modelChain.slice(0, 1)) }),
      { id: 'connections', primitive: 'markdown', fallbackMarkdown: [...settings.skills, ...settings.connections, ...settings.toolsets].join('\n') },
    ];
    // A failed shelf read must not turn into an empty shelf or prevent profile recovery.
    try {
      const skills = await deps.skills(botId);
      deps.assertOwner(owner);
      resource.blocks.push({ id: 'skills', primitive: 'markdown', fallbackMarkdown: skills.map(skill => `${skill.name}\n${skill.description}`).join('\n\n') });
    } catch { deps.assertOwner(owner); }
    if (deps.directHistory) {
      try {
        const history = await deps.directHistory(botId);
        deps.assertOwner(owner);
        resource.blocks.push({ id: 'direct', primitive: 'markdown', fallbackMarkdown: history });
      } catch { deps.assertOwner(owner); }
    }
    for (const operation of (source.status === 'paused' ? ['resume', 'delete'] : ['restart', 'delete']) as Array<'restart' | 'delete' | 'resume'>) {
      actions.push({ id: issue(context, owner, settings, operation), label: copy[operation], tone: operation === 'delete' ? 'destructive' : 'neutral',
        confirmation: { title: copy[operation], body: { restart: copy.restartBody, delete: copy.deleteBody, resume: copy.resumeBody }[operation], confirmLabel: copy[operation] },
        ...(operation === 'delete' ? { fields: [{ id: 'confirmName', label: copy.name, kind: 'text', required: true }] } : {}) });
      resource.blocks.push({ id: operation, primitive: 'action', fallbackMarkdown: copy[operation].fallback, data: { actionId: actions.at(-1)!.id } });
    }
    resource.actions = actions;
    deps.assertOwner(owner);
    return resource;
  };
  const invoke = async (context: RemoteResourceHostContext, request: RemoteActionInvokeRequest): Promise<RemoteActionInvokeResponse> => {
    const external = bound.get(request.actionId);
    if (external) {
      if (external.expires <= now() || external.controller !== context.controllerDeviceId
        || request.collectionId !== external.ref.collectionId || request.resourceRef?.collectionId !== external.ref.collectionId
        || request.resourceRef?.kind !== external.ref.kind || request.resourceRef?.id !== external.ref.id)
        throwIpcError('PRECONDITION_FAILED', 'Refresh before retrying');
      deps.assertOwner(external.owner);
      const lock = `${external.owner}:${external.ref.collectionId}:${external.ref.id}`;
      if (submitting.has(lock)) throwIpcError('PRECONDITION_FAILED', 'Resource is being updated');
      submitting.add(lock);
      try {
        await external.check();
        if (bound.get(request.actionId) !== external || external.expires <= now()) throwIpcError('PRECONDITION_FAILED', 'Action already submitted or expired');
        bound.delete(request.actionId);
        const response = await external.run(request);
        deps.assertOwner(external.owner);
        return response;
      } finally { submitting.delete(lock); }
    }
    const grant = grants.get(request.actionId);
    if (!grant || grant.expires <= now() || grant.controller !== context.controllerDeviceId || grant.botId !== request.resourceRef?.id
      || request.collectionId !== 'teammates' || request.resourceRef?.collectionId !== 'teammates' || request.resourceRef?.kind !== 'bot')
      throwIpcError('PRECONDITION_FAILED', 'Refresh teammate settings before retrying');
    deps.assertOwner(grant.owner);
    const lock = `${grant.owner}:teammates:${grant.botId}`;
    if (submitting.has(lock)) throwIpcError('PRECONDITION_FAILED', 'Teammate is being updated');
    submitting.add(lock);
    try {
    const guard = async () => {
      deps.assertOwner(grant.owner);
      const current = await deps.read(grant.botId);
      deps.assertOwner(grant.owner);
      if (settingsRevision(current) !== grant.revision) throwIpcError('PRECONDITION_FAILED', 'Teammate settings changed; refresh before retrying');
    };
    await guard();
    const input = request.input ?? {};
    const allowed: readonly string[] = { models: ['followsDefault', 'modelChain', 'taskFollowsPrimary', 'taskModel'], profile: ['name', 'description', 'identity'], memory: ['memory', 'userContext'], permissions: ['permissions'], restart: [], resume: [], delete: ['confirmName'] }[grant.operation];
    if (Object.keys(input).some(key => !allowed.includes(key))) throwIpcError('INVALID_PARAMS', 'Unknown teammate field');
    const string = (key: string, max = 12_000) => {
      const value = input[key];
      if (typeof value !== 'string' || value.length > max) throwIpcError('INVALID_PARAMS', 'Invalid teammate field');
      return value;
    };
    let patch: Record<string, unknown> | null = null;
    if (grant.operation === 'profile') patch = {
      ...('name' in input ? { name: string('name', 200) } : {}),
      ...('description' in input ? { description: string('description') } : {}),
      ...('identity' in input ? { identitySource: string('identity') } : {}),
    };
    if (grant.operation === 'memory') {
      if ('memory' in input && typeof input.memory !== 'boolean') throwIpcError('INVALID_PARAMS', 'Invalid memory setting');
      patch = {
        ...('userContext' in input ? { userContextSource: string('userContext') } : {}),
        ...('memory' in input ? { capabilities: { memory: input.memory } } : {}),
      };
    }
    if (grant.operation === 'models') {
      const settings = await deps.read(grant.botId); deps.assertOwner(grant.owner);
      if ('followsDefault' in input && typeof input.followsDefault !== 'boolean') throwIpcError('INVALID_PARAMS', 'Invalid model preference');
      const followsDefault = input.followsDefault ?? settings.followsDefault;
      let chain = settings.modelChain;
      if ('modelChain' in input) {
        let value: unknown;
        try { value = JSON.parse(string('modelChain')); } catch { throwIpcError('INVALID_PARAMS', 'Invalid model chain'); }
        chain = normalizeBotModelChain(value);
        if (!Array.isArray(value) || !chain.length || chain.length !== value.length || value.some(route => !['claude', 'codex', 'pi'].includes(route?.harness))) throwIpcError('INVALID_PARAMS', 'Invalid model chain');
      }
      const capabilities: Record<string, unknown> = {};
      // Old clients only send primary fields. Absence must preserve the task override.
      if ('followsDefault' in input || 'modelChain' in input) {
        capabilities.modelChainOverride = followsDefault ? null : chain;
        capabilities.modelOverride = null;
      }
      if ('taskFollowsPrimary' in input || 'taskModel' in input) {
        if ('taskFollowsPrimary' in input && typeof input.taskFollowsPrimary !== 'boolean')
          throwIpcError('INVALID_PARAMS', 'Invalid task model preference');
        const inherits = input.taskFollowsPrimary ?? !settings.taskModelOverride;
        let route: BotModelRoute | null = settings.taskModelOverride ?? chain[0] ?? null;
        if (!inherits && 'taskModel' in input) {
          try {
            const value = JSON.parse(string('taskModel'));
            if (!Array.isArray(value) || value.length !== 1) throw new Error('Invalid task model');
            route = readBotTaskModelOverride(value[0]);
          } catch { throwIpcError('INVALID_PARAMS', 'Invalid task model'); }
        }
        if (!inherits && !route) throwIpcError('INVALID_PARAMS', 'Task model required');
        capabilities.taskModelOverride = inherits ? null : route;
      }
      patch = { capabilities };
    }
    if (patch && !Object.keys(patch).length) throwIpcError('INVALID_PARAMS', 'No changed teammate fields');
    if (grant.operation === 'permissions') {
      if (!['ask', 'auto', 'trusted'].includes(String(input.permissions))) throwIpcError('INVALID_PARAMS', 'Invalid permissions');
      patch = { capabilities: { permissions: input.permissions } };
    }
    // Consume before any side effect: ambiguous responses must be reconciled by a new read, never replayed.
    if (grants.get(request.actionId) !== grant)
      throwIpcError('PRECONDITION_FAILED', 'Action already submitted; refresh teammate settings');
    grants.delete(request.actionId);
    let warnings: string[] | undefined;
    if (patch) await deps.update({ id: grant.botId, ...patch }, grant.version);
    else if (grant.operation === 'restart' || grant.operation === 'delete' || grant.operation === 'resume')
      ({ warnings } = await deps.lifecycle(grant.botId, grant.operation, grant.operation === 'delete' ? string('confirmName', 200) : undefined, guard));
    else throw new RemoteResourceRegistryError('UNSUPPORTED_CAPABILITY', 'Action unavailable');
    deps.assertOwner(grant.owner);
    return { effects: [
      { kind: 'refresh-collection', collectionId: request.collectionId },
      ...(grant.operation === 'delete' ? [] : [{ kind: 'refresh-resource' as const, ref: request.resourceRef! }]),
      { kind: 'toast', message: warnings?.length ? copy.warning : grant.operation === 'delete' ? copy.deleted : grant.operation === 'restart' ? copy.restarted : copy.saved },
    ] };
    } finally { submitting.delete(lock); }
  };
  return { get, invoke, bindResource };
}
