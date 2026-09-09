/**
 * 登录时本地数据共享策略。
 *
 * 该类型只描述允许共享的本地数据类别，不包含账号凭证、token 或文件内容。
 */
export interface LocalProjectSyncOptions {
  /** 是否共享项目会话、消息、标题和会话状态。 */
  projectConversation: boolean;
  /** 是否共享本地项目目录引用，不复制目录内容。 */
  projectFiles: boolean;
  /** 是否共享项目名称、别名、路径和最近打开状态。 */
  projectList: boolean;
  /** 是否共享项目终端、任务和执行结果等安全投影。 */
  projectRuntimeRecords: boolean;
  /** 是否共享没有绑定项目的普通聊天。 */
  independentConversations: boolean;
  /** 是否共享主题、语言、布局和默认模型等非敏感偏好。 */
  nonSensitivePreferences: boolean;
}

/** 登录页显示的默认策略：六项共享内容全部开启。 */
export const DEFAULT_LOCAL_PROJECT_SYNC_OPTIONS: LocalProjectSyncOptions = {
  projectConversation: true,
  projectFiles: true,
  projectList: true,
  projectRuntimeRecords: true,
  independentConversations: true,
  nonSensitivePreferences: true,
};

/** 复制策略，避免弹窗草稿通过对象引用污染已经确认的登录策略。 */
export function copyLocalProjectSyncOptions(
  options: LocalProjectSyncOptions,
): LocalProjectSyncOptions {
  return { ...options };
}

/** IPC 输入必须是六个明确布尔值；缺字段不会被默认值静默补齐。 */
export function parseLocalProjectSyncOptions(value: unknown): LocalProjectSyncOptions | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const keys: readonly (keyof LocalProjectSyncOptions)[] = [
    'projectConversation',
    'projectFiles',
    'projectList',
    'projectRuntimeRecords',
    'independentConversations',
    'nonSensitivePreferences',
  ];
  if (keys.some((key) => typeof record[key] !== 'boolean')) return null;
  return {
    projectConversation: record.projectConversation as boolean,
    projectFiles: record.projectFiles as boolean,
    projectList: record.projectList as boolean,
    projectRuntimeRecords: record.projectRuntimeRecords as boolean,
    independentConversations: record.independentConversations as boolean,
    nonSensitivePreferences: record.nonSensitivePreferences as boolean,
  };
}
