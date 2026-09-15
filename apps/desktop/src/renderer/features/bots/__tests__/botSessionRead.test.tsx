// @vitest-environment jsdom

import { act, cleanup, render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

const mocks = vi.hoisted(() => ({
  navigate: vi.fn(),
  params: { botId: 'bot-1', sessionId: 'session-1' } as Record<string, string | undefined>,
}));

vi.mock('react-router-dom', () => ({
  useNavigate: () => mocks.navigate,
  useParams: () => mocks.params,
}));
vi.mock('@/features/cc-agent/CCAgentSessionView', () => ({
  CCAgentSessionView: ({ botUnreadBoundaryAt }: { botUnreadBoundaryAt?: number | null }) => (
    <div data-testid="chat" data-unread-boundary={botUnreadBoundaryAt ?? ''} />
  ),
}));

import { BotSessionView } from '../BotSessionView';
import {
  getBotLastReadAt,
  markBotRead,
  resetBotReadStateForTests,
  setBotReadStateOwner,
} from '../botReadState';
import { getBotProfiles, refreshBotProfiles } from '../botStore';

let messageListeners: Array<(payload: unknown) => void> = [];

function installElectronApi(bot: unknown, listedBot: unknown = bot): void {
  Object.defineProperty(window, 'electronAPI', {
    configurable: true,
    writable: true,
    value: {
      localDb: {
        bots: {
          get: vi.fn(async () => bot),
          list: vi.fn(async () => [listedBot]),
        },
        messages: {
          onCreated: (cb: (payload: unknown) => void) => {
            messageListeners.push(cb);
            return () => {
              messageListeners = messageListeners.filter((entry) => entry !== cb);
            };
          },
        },
      },
    },
  });
}

/** get/list 永不 resolve 的 API 桩：证明快路径挂载不再依赖这两个 IPC。 */
function installHangingElectronApi(): void {
  Object.defineProperty(window, 'electronAPI', {
    configurable: true,
    writable: true,
    value: {
      localDb: {
        bots: {
          get: () => new Promise(() => undefined),
          list: () => new Promise(() => undefined),
        },
        messages: {
          onCreated: (cb: (payload: unknown) => void) => {
            messageListeners.push(cb);
            return () => {
              messageListeners = messageListeners.filter((entry) => entry !== cb);
            };
          },
        },
      },
    },
  });
}

const readyBot = {
  id: 'bot-1',
  name: 'PR steward',
  status: 'active',
  enabled: true,
  sessions: [{ id: 'session-1', kind: 'chat', role: 'canonical', status: 'active' }],
};

beforeEach(() => {
  messageListeners = [];
  window.localStorage.clear();
  resetBotReadStateForTests();
  setBotReadStateOwner('owner-1');
  mocks.params = { botId: 'bot-1', sessionId: 'session-1' };
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(10_000);
  installElectronApi(readyBot);
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  resetBotReadStateForTests();
});

describe('Bot conversation read position', () => {
  it('marks the conversation read as soon as the chat is mounted', async () => {
    render(<BotSessionView />);

    await waitFor(() => expect(getBotLastReadAt('bot-1')).toBe(10_000));
  });

  it('preserves the entry read position for the unread divider while marking the chat read', async () => {
    markBotRead('bot-1', 5_000);
    installElectronApi(readyBot, { ...readyBot, unreadCount: 2 });

    const view = render(<BotSessionView />);

    // Rendering the divider can precede the passive effect that advances the read position.
    await waitFor(() => {
      expect(view.getByTestId('chat').dataset.unreadBoundary).toBe('5000');
      expect(getBotLastReadAt('bot-1')).toBe(10_000);
    });
  });

  it('keeps advancing the read position while the user is watching the chat', async () => {
    render(<BotSessionView />);
    await waitFor(() => expect(messageListeners.length).toBe(1));

    vi.setSystemTime(20_000);
    act(() => {
      for (const listener of messageListeners) listener({ sessionId: 'session-1' });
    });
    expect(getBotLastReadAt('bot-1')).toBe(20_000);

    // A row belonging to another task must not mark this Bot read.
    vi.setSystemTime(30_000);
    act(() => {
      for (const listener of messageListeners) listener({ sessionId: 'other-session' });
    });
    expect(getBotLastReadAt('bot-1')).toBe(20_000);
  });

  it('does not mark anything read when the Bot task cannot be opened', async () => {
    installElectronApi({ ...readyBot, status: 'archived' });

    render(<BotSessionView />);

    await waitFor(() => expect(messageListeners.length).toBe(0));
    expect(getBotLastReadAt('bot-1')).toBeNull();
  });
});

describe('Bot conversation fast gate (botStore projection)', () => {
  it('mounts the chat on the first frame when the store projection confirms the session', async () => {
    // 先经真实水合路径（api.list → normalizeDbProfile）灌 store，保证 profile
    // 形状与生产一致（含 status / sessions 投影）。
    installElectronApi(readyBot);
    refreshBotProfiles();
    await waitFor(() => expect(getBotProfiles().some((bot) => bot.id === 'bot-1')).toBe(true));
    // 再换成永不 resolve 的 API 桩：渲染后的挂载不能再依赖这两个 IPC。
    installHangingElectronApi();

    const view = render(<BotSessionView />);

    // 首帧同步出现聊天视图；「挂载即标已读」的 effect 也照常执行。
    expect(view.getByTestId('chat')).toBeTruthy();
    await waitFor(() => expect(getBotLastReadAt('bot-1')).toBe(10_000));
  });

  it('still demotes to unavailable when the authoritative IPC contradicts the projection', async () => {
    // 水合一份 active 投影，然后把权威 IPC 改口为 archived：快路径先挂聊天，
    // 确认结论到达后必须纠正（快路径不允许吞掉真实失效）。
    installElectronApi(readyBot);
    refreshBotProfiles();
    await waitFor(() => expect(getBotProfiles()).toHaveLength(1));
    installElectronApi({ ...readyBot, status: 'archived' });

    const view = render(<BotSessionView />);
    expect(view.getByTestId('chat')).toBeTruthy();
    await waitFor(() => expect(view.getByText('bots.sessionUnavailableTitle')).toBeTruthy());
  });
});
