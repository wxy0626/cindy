// @vitest-environment jsdom

import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  DEFAULT_LOCAL_PROJECT_SYNC_OPTIONS,
  type LocalProjectSyncOptions,
} from '../../../../shared/localProjectSync';
import { LoginLocalProjectSyncDialog } from '../LoginControls';

const fields: ReadonlyArray<{
  key: keyof LocalProjectSyncOptions;
  label: string;
  description: string;
}> = [
  { key: 'projectConversation', label: '项目对话', description: '项目会话、消息、标题、会话状态' },
  { key: 'projectFiles', label: '项目文件访问', description: '共享本地项目路径引用，不复制代码、素材或配置文件内容' },
  { key: 'projectList', label: '项目列表与信息', description: '项目名称、别名、项目路径、最近打开状态' },
  { key: 'projectRuntimeRecords', label: '项目运行记录', description: '项目相关的终端记录、任务记录、执行结果' },
  { key: 'independentConversations', label: '独立对话', description: '没有绑定项目的普通聊天' },
  { key: 'nonSensitivePreferences', label: '非敏感应用偏好', description: '主题、语言、界面布局、默认模型选择等' },
];

function renderDialog(
  options: LocalProjectSyncOptions = DEFAULT_LOCAL_PROJECT_SYNC_OPTIONS,
  onOptionChange = vi.fn(),
  onConfirm = vi.fn(),
  onCancel = vi.fn(),
) {
  return render(
    <LoginLocalProjectSyncDialog
      options={options}
      fields={fields}
      onOptionChange={onOptionChange}
      title="本地项目同步"
      description="选择要共享到另一个账号的本地数据"
      enableAllLabel="全部开启"
      disableAllLabel="全部关闭"
      confirmLabel="确认"
      cancelLabel="取消"
      onConfirm={onConfirm}
      onCancel={onCancel}
    />,
  );
}

afterEach(() => {
  vi.clearAllMocks();
});

describe('本地项目同步设置弹窗', () => {
  it('渲染六个独立开关，并符合默认开关状态', () => {
    renderDialog();

    expect(screen.getByTestId('login-local-project-sync-dialog')).toBeTruthy();
    expect(screen.getAllByRole('switch')).toHaveLength(6);
    for (const key of [
      'projectConversation',
      'projectFiles',
      'projectList',
      'projectRuntimeRecords',
      'independentConversations',
    ]) {
      expect(screen.getByTestId('login-local-project-sync-' + key).getAttribute('data-state')).toBe(
        'checked',
      );
    }
    expect(
      screen
        .getByTestId('login-local-project-sync-nonSensitivePreferences')
        .getAttribute('data-state'),
    ).toBe('checked');
  });

  it('每个开关独立回调，确认和取消按钮分别只触发对应回调', () => {
    const onOptionChange = vi.fn();
    const onConfirm = vi.fn();
    const onCancel = vi.fn();
    renderDialog(DEFAULT_LOCAL_PROJECT_SYNC_OPTIONS, onOptionChange, onConfirm, onCancel);

    fireEvent.click(screen.getByTestId('login-local-project-sync-projectConversation'));
    fireEvent.click(screen.getByTestId('login-local-project-sync-nonSensitivePreferences'));
    expect(onOptionChange).toHaveBeenNthCalledWith(1, 'projectConversation', false);
    expect(onOptionChange).toHaveBeenNthCalledWith(2, 'nonSensitivePreferences', false);

    fireEvent.click(screen.getByTestId('login-local-project-sync-confirm'));
    expect(onConfirm).toHaveBeenCalledOnce();
    expect(onCancel).not.toHaveBeenCalled();
  });

  it('一键开启和一键关闭会更新全部六项，不影响确认回调', () => {
    const onOptionChange = vi.fn();
    const onConfirm = vi.fn();
    renderDialog(DEFAULT_LOCAL_PROJECT_SYNC_OPTIONS, onOptionChange, onConfirm);

    fireEvent.click(screen.getByTestId('login-local-project-sync-disable-all'));
    expect(onOptionChange).toHaveBeenCalledTimes(6);
    expect(onOptionChange).toHaveBeenNthCalledWith(1, 'projectConversation', false);
    expect(onOptionChange).toHaveBeenNthCalledWith(6, 'nonSensitivePreferences', false);

    onOptionChange.mockClear();
    fireEvent.click(screen.getByTestId('login-local-project-sync-enable-all'));
    expect(onOptionChange).toHaveBeenCalledTimes(6);
    expect(onOptionChange).toHaveBeenNthCalledWith(1, 'projectConversation', true);
    expect(onOptionChange).toHaveBeenNthCalledWith(6, 'nonSensitivePreferences', true);
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it('Esc、遮罩和取消都只触发关闭回调，不触发确认回调', () => {
    const onConfirm = vi.fn();
    const onCancel = vi.fn();
    renderDialog(DEFAULT_LOCAL_PROJECT_SYNC_OPTIONS, vi.fn(), onConfirm, onCancel);

    fireEvent.keyDown(screen.getByTestId('login-local-project-sync-dialog'), { key: 'Escape' });
    expect(onCancel).toHaveBeenCalledOnce();
    expect(onConfirm).not.toHaveBeenCalled();

    onCancel.mockClear();
    fireEvent.mouseDown(screen.getByTestId('login-local-project-sync-dialog'));
    expect(onCancel).toHaveBeenCalledOnce();
    expect(onConfirm).not.toHaveBeenCalled();

    fireEvent.click(screen.getByTestId('login-local-project-sync-cancel'));
    expect(onCancel).toHaveBeenCalledTimes(2);
    expect(onConfirm).not.toHaveBeenCalled();
  });
});
