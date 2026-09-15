import { useEffect, useState } from 'react';
import { ArrowLeft, CircleAlert, RefreshCcw } from 'lucide-react';
import { useNavigate, useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';

import { Spinner } from '@/components/ui/spinner';
import { CCAgentSessionView } from '@/features/cc-agent/CCAgentSessionView';
import type { ComposerBotMention } from '@/lib/fileTypes';
import { getBotLastReadAt, markBotRead } from './botReadState';
import { getBotProfiles, getBotUnreadCounts } from './botStore';
import type { BotChatIdentity } from './BotSessionContentHeader';
import { useBotIslandVisibleSession } from './useBotIslandVisibleSession';

type BotSessionGate =
  | { kind: 'loading' }
  | {
      kind: 'ready';
      mentions: ComposerBotMention[];
      identity: BotChatIdentity;
      /** True only for the Bot's own canonical chat (not a mounted channel route). */
      isCanonical: boolean;
      /** Read position captured before opening advances it; null when entry had no unread replies. */
      unreadBoundaryAt: number | null;
    }
  | { kind: 'unavailable' }
  | { kind: 'error'; message: string };

function readBotChatIdentity(bot: unknown, botId: string): BotChatIdentity {
  const candidate = (bot ?? {}) as { name?: unknown; avatar?: unknown; avatarColor?: unknown };
  return {
    id: botId,
    name: typeof candidate.name === 'string' ? candidate.name : '',
    avatar: typeof candidate.avatar === 'string' ? candidate.avatar : null,
    avatarColor: typeof candidate.avatarColor === 'string' ? candidate.avatarColor : null,
  };
}

function readBotMention(value: unknown, currentBotId: string): ComposerBotMention | null {
  if (!value || typeof value !== 'object') return null;
  const candidate = value as {
    id?: unknown;
    name?: unknown;
    description?: unknown;
    enabled?: unknown;
    status?: unknown;
  };
  if (
    typeof candidate.id !== 'string' ||
    candidate.id === currentBotId ||
    typeof candidate.name !== 'string' ||
    candidate.enabled === false ||
    (candidate.status !== undefined && candidate.status !== 'active')
  ) {
    return null;
  }
  return {
    id: candidate.id,
    name: candidate.name,
    ...(typeof candidate.description === 'string' && candidate.description.trim()
      ? { description: candidate.description }
      : {}),
  };
}

/**
 * 同步快路径（切伙伴提速，2026-09-14）：botStore 内存投影已确认「伙伴 active +
 * 目标会话是 active 的 chat 投影」时，首帧直接产出 ready gate —— 省掉一次全屏
 * spinner 和两个串行 IPC 往返（此前切伙伴要连吃 BotsHomeView、本 gate 两段
 * 近黑底转圈，体感即"黑屏闪一下"）。数据与 main 侧投影同源；权威 IPC 确认
 * 仍在后台执行，结论相悖时由既有 effect 纠正为 unavailable/error，慢路径语义不变。
 */
function computeFastGate(
  botId: string | undefined,
  sessionId: string | undefined,
): BotSessionGate | null {
  if (!botId || !sessionId) return null;
  const profiles = getBotProfiles();
  const bot = profiles.find((candidate) => candidate.id === botId);
  if (!bot || bot.status !== 'active') return null;
  const projection = bot.sessions.find(
    (row) => row.id === sessionId && row.kind === 'chat' && row.status === 'active',
  );
  if (!projection) return null;
  const lastReadAt = getBotLastReadAt(botId);
  const unreadCount = getBotUnreadCounts()[botId] ?? 0;
  return {
    kind: 'ready',
    // 欢迎语只属于主任务（与慢路径同一口径）。
    isCanonical: projection.role === 'canonical',
    unreadBoundaryAt:
      projection.role === 'canonical' && unreadCount > 0 ? lastReadAt : null,
    identity: readBotChatIdentity(bot, botId),
    mentions: profiles
      .map((candidate) => readBotMention(candidate, botId))
      .filter((candidate): candidate is ComposerBotMention => candidate !== null),
  };
}

/**
 * ready→ready 且内容完全一致时不 setGate：权威确认往往与内存投影同值，
 * 跳过后可避免刚挂载的重型聊天子树（CCAgentSessionView）再吃一次全量 props 更新。
 */
function isSameReadyGate(a: BotSessionGate, b: BotSessionGate): boolean {
  if (a.kind !== 'ready' || b.kind !== 'ready') return false;
  return (
    a.isCanonical === b.isCanonical &&
    a.unreadBoundaryAt === b.unreadBoundaryAt &&
    a.identity.name === b.identity.name &&
    a.identity.avatar === b.identity.avatar &&
    a.identity.avatarColor === b.identity.avatarColor &&
    a.mentions.length === b.mentions.length &&
    a.mentions.every((mention, index) => mention.id === b.mentions[index]?.id)
  );
}

/**
 * A Bot URL is a navigation projection, not authority to adopt an arbitrary
 * Cindy task. Check the durable Bot link before mounting the writable chat.
 */
export function BotSessionView() {
  const { botId, sessionId } = useParams();
  return <BotSessionGateView key={JSON.stringify([botId, sessionId])} />;
}

function BotSessionGateView() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { botId, sessionId } = useParams();
  const [reloadVersion, setReloadVersion] = useState(0);
  // 首帧即尝试快路径：内存投影确认可用时直接挂聊天视图，不进 loading。
  // 投影缺失/不可信时回落到原 loading → IPC 权威确认链路。
  const [gate, setGate] = useState<BotSessionGate>(
    () => computeFastGate(botId, sessionId) ?? { kind: 'loading' },
  );
  useBotIslandVisibleSession(gate.kind === 'ready' ? sessionId ?? null : null);

  useEffect(() => {
    let cancelled = false;
    if (!botId || !sessionId) {
      setGate({ kind: 'unavailable' });
      return () => {
        cancelled = true;
      };
    }
    // 不再无条件回退 loading：快路径已 ready 时保持当前画面，本次 IPC 只做
    // 权威确认与数据刷新（重试入口自己负责把 gate 拨回 loading）。
    const lastReadAt = getBotLastReadAt(botId);
    void Promise.all([
      window.electronAPI.localDb.bots.get(botId),
      window.electronAPI.localDb.bots.list(
        lastReadAt === null ? undefined : { lastReadAtByBotId: { [botId]: lastReadAt } },
      ),
    ])
      .then(([bot, bots]) => {
        if (cancelled) return;
        if (!bot || typeof bot !== 'object') {
          setGate({ kind: 'unavailable' });
          return;
        }
        const sessions = (bot as { sessions?: unknown }).sessions;
        const profileStatus = (bot as { status?: unknown }).status;
        const activeProjection = Array.isArray(sessions)
          ? sessions.find((row): row is { role?: unknown } => {
              if (!row || typeof row !== 'object') return false;
              const projection = row as { id?: unknown; kind?: unknown; status?: unknown };
              return (
                projection.id === sessionId &&
                projection.kind === 'chat' &&
                projection.status === 'active'
              );
            })
          : undefined;
        if (profileStatus !== 'active' || !activeProjection) {
          setGate({ kind: 'unavailable' });
          return;
        }
        const listedBot = Array.isArray(bots)
          ? bots.find(
              (candidate) =>
                candidate &&
                typeof candidate === 'object' &&
                (candidate as { id?: unknown }).id === botId,
            )
          : undefined;
        const unreadCount =
          listedBot &&
          typeof listedBot === 'object' &&
          typeof (listedBot as { unreadCount?: unknown }).unreadCount === 'number'
            ? (listedBot as { unreadCount: number }).unreadCount
            : 0;
        setGate((prev) => {
          const nextGate: BotSessionGate = {
            kind: 'ready',
            // 欢迎语只属于主任务:渠道路由任务是「别处的对话被接进来」,
            // 在那里冒出一句自我介绍是插话,不是打招呼。
            isCanonical: activeProjection?.role === 'canonical',
            unreadBoundaryAt:
              activeProjection?.role === 'canonical' && unreadCount > 0 ? lastReadAt : null,
            identity: readBotChatIdentity(bot, botId),
            mentions: Array.isArray(bots)
              ? bots
                  .map((candidate) => readBotMention(candidate, botId))
                  .filter((candidate): candidate is ComposerBotMention => candidate !== null)
              : [],
          };
          return isSameReadyGate(prev, nextGate) ? prev : nextGate;
        });
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        setGate({
          kind: 'error',
          message: error instanceof Error ? error.message : String(error),
        });
      });
    return () => {
      cancelled = true;
    };
  }, [botId, reloadVersion, sessionId]);

  // Opening the conversation is what marks it read, and staying in it keeps it
  // read: while this view is mounted every row that lands in the task advances
  // the read position, so a reply the user is watching arrive never turns into
  // an unread badge behind their back.
  useEffect(() => {
    if (gate.kind !== 'ready' || !botId || !sessionId) return;
    markBotRead(botId);
    const subscribe = window.electronAPI?.localDb?.messages?.onCreated;
    if (typeof subscribe !== 'function') return;
    const unsubscribe = subscribe((payload: unknown) => {
      const incoming = (payload as { sessionId?: unknown } | null)?.sessionId;
      if (incoming !== sessionId) return;
      markBotRead(botId);
    });
    return () => {
      unsubscribe?.();
    };
  }, [botId, gate.kind, sessionId]);

  if (gate.kind === 'loading') {
    return (
      <main className="flex h-full items-center justify-center bg-[var(--surface)]">
        <Spinner
          size={20}
          className="text-[var(--text-tertiary)]"
          role="status"
          aria-label={t('ccAgent.common.loading')}
        />
      </main>
    );
  }
  if (gate.kind !== 'ready' || !sessionId) {
    const failed = gate.kind === 'error';
    return (
      <main className="flex h-full items-center justify-center bg-[var(--surface)] p-6">
        <section className="w-full max-w-md rounded-xl border border-[var(--border-default)] bg-[var(--surface-elevated)] p-5 text-center">
          <CircleAlert size={24} className="mx-auto text-[var(--text-danger)]" aria-hidden />
          <h1 className="mt-3 text-16 font-medium text-[var(--text-primary)]">
            {t(failed ? 'bots.sessionLoadFailedTitle' : 'bots.sessionUnavailableTitle')}
          </h1>
          <p className="mt-2 break-words text-12 leading-5 text-[var(--text-secondary)] [overflow-wrap:anywhere]">
            {failed
              ? t('bots.sessionLoadFailedDescription')
              : t('bots.sessionUnavailableDescription')}
          </p>
          {failed && gate.message ? (
            <p className="mt-3 max-h-24 overflow-y-auto whitespace-pre-wrap rounded-lg bg-[var(--surface)] px-3 py-2 text-left text-11 text-[var(--text-danger)] [overflow-wrap:anywhere]">
              {gate.message}
            </p>
          ) : null}
          <div className="mt-4 flex flex-wrap justify-center gap-2">
            <button
              type="button"
              onClick={() => navigate(botId ? `/bots/${botId}` : '/bots')}
              className="inline-flex h-9 items-center gap-2 rounded-lg border border-[var(--border-default)] px-3 text-12 text-[var(--text-secondary)] hover:bg-[var(--surface-hover)]"
            >
              <ArrowLeft size={14} />
              {t('bots.backToBot')}
            </button>
            {failed ? (
              <button
                type="button"
                onClick={() => {
                  // 重试要重新过 gate：这里负责拨回 loading（effect 已不再无条件重置）。
                  setGate({ kind: 'loading' });
                  setReloadVersion((value) => value + 1);
                }}
                className="inline-flex h-9 items-center gap-2 rounded-lg bg-[var(--accent-cta-bg)] px-3 text-12 font-medium text-[var(--accent-pure-cta-fg)]"
              >
                <RefreshCcw size={14} />
                {t('bots.retry')}
              </button>
            ) : null}
          </div>
        </section>
      </main>
    );
  }
  return (
    <main className="relative flex h-full min-w-0 overflow-hidden bg-[var(--surface)]">
      <div className="min-w-0 flex-1">
        <CCAgentSessionView
          botMentions={gate.mentions}
          botIdentity={gate.identity}
          botUnreadBoundaryAt={gate.unreadBoundaryAt}
        />
      </div>
    </main>
  );
}
