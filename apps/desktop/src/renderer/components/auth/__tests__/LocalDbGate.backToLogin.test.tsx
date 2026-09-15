// @vitest-environment jsdom

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  exitLocalMode: vi.fn(),
  logout: vi.fn(),
  warn: vi.fn(),
}));

vi.mock('@/contexts/AuthContext', () => ({
  useAuth: () => ({
    dataOwnerId: 'local-v1',
    mode: 'local',
    exitLocalMode: mocks.exitLocalMode,
    logout: mocks.logout,
  }),
}));

vi.mock('@/lib/logger', () => ({
  createLogger: () => ({
    // info：gate attempt 启动打点（2026-09-12 启动分解探针）会调用。
    info: vi.fn(),
    warn: mocks.warn,
    error: vi.fn(),
  }),
}));

vi.mock('@/components/error/LocalDbFatalScreen', () => ({
  LocalDbFatalScreen: ({ onBackToLogin }: { onBackToLogin?: () => void }) => (
    <button type="button" onClick={onBackToLogin}>
      back to login
    </button>
  ),
}));

// 启动提速(2026-09-12)：LocalDbGate 现在会预加载主功能区模块（路由级懒加载的
// 另一半，见 router.tsx 头注）。单元测试不加载真实重图，仅验证 fatal 恢复链路。
vi.mock('@/components/layout/MainLayout', () => ({ MainLayout: () => null }));
vi.mock('@/features/cc-agent/CCAgentFeatureLayout', () => ({
  CCAgentFeatureLayout: () => null,
}));
vi.mock('@/features/cc-agent/CCAgentIndexRedirect', () => ({
  CCAgentIndexRedirect: () => null,
}));
vi.mock('@/features/cc-agent/CCAgentSessionView', () => ({
  CCAgentSessionView: () => null,
}));
vi.mock('@/features/cc-agent/NewMakerDraftRoute', () => ({
  NewMakerDraftRoute: () => null,
}));

import { LocalDbGate } from '../LocalDbGate';

describe('LocalDbGate fatal recovery', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.exitLocalMode.mockRejectedValue(new Error('owner teardown failed'));
    mocks.logout.mockResolvedValue(undefined);
    (window as unknown as { electronAPI: unknown }).electronAPI = {
      localDb: {
        ensureReady: vi.fn().mockResolvedValue({
          ready: false,
          error: { code: 'DB_INIT_FAILED', message: 'broken database' },
        }),
      },
      appReadyForBot: vi.fn(),
    };
  });

  it('navigates back to login even when leaving local mode rejects', async () => {
    render(
      <MemoryRouter initialEntries={['/app']}>
        <Routes>
          <Route path="/app" element={<LocalDbGate />}>
            <Route index element={<div>main</div>} />
          </Route>
          <Route path="/login" element={<div>login page</div>} />
        </Routes>
      </MemoryRouter>,
    );

    fireEvent.click(await screen.findByRole('button', { name: 'back to login' }));

    await waitFor(() => expect(screen.getByText('login page')).toBeTruthy());
    expect(mocks.exitLocalMode).toHaveBeenCalledOnce();
    expect(mocks.warn).toHaveBeenCalledWith(
      'failed to leave the current session from local-db fatal screen',
      expect.any(Error),
    );
  });
});
