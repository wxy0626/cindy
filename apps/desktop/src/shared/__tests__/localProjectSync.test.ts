import { describe, expect, it } from 'vitest';

import {
  DEFAULT_LOCAL_PROJECT_SYNC_OPTIONS,
  copyLocalProjectSyncOptions,
  parseLocalProjectSyncOptions,
} from '../localProjectSync';

describe('本地项目同步策略', () => {
  it('默认开启全部六项共享内容', () => {
    expect(DEFAULT_LOCAL_PROJECT_SYNC_OPTIONS).toEqual({
      projectConversation: true,
      projectFiles: true,
      projectList: true,
      projectRuntimeRecords: true,
      independentConversations: true,
      nonSensitivePreferences: true,
    });
  });

  it('复制策略时不共享对象引用', () => {
    const copy = copyLocalProjectSyncOptions(DEFAULT_LOCAL_PROJECT_SYNC_OPTIONS);
    expect(copy).toEqual(DEFAULT_LOCAL_PROJECT_SYNC_OPTIONS);
    expect(copy).not.toBe(DEFAULT_LOCAL_PROJECT_SYNC_OPTIONS);
  });

  it('只接受六个明确布尔字段，缺字段或非法类型全部拒绝', () => {
    expect(parseLocalProjectSyncOptions(DEFAULT_LOCAL_PROJECT_SYNC_OPTIONS)).toEqual(
      DEFAULT_LOCAL_PROJECT_SYNC_OPTIONS,
    );
    expect(
      parseLocalProjectSyncOptions({
        ...DEFAULT_LOCAL_PROJECT_SYNC_OPTIONS,
        projectFiles: 'yes',
      }),
    ).toBeNull();
    expect(
      parseLocalProjectSyncOptions({
        projectConversation: true,
      }),
    ).toBeNull();
    expect(parseLocalProjectSyncOptions(null)).toBeNull();
    expect(parseLocalProjectSyncOptions([])).toBeNull();
  });
});
