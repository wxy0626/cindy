import { useEffect, useMemo, useState } from 'react';
import { ArrowLeft, CircleAlert, RefreshCcw } from 'lucide-react';
import { useNavigate, useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';

import { Spinner } from '@/components/ui/spinner';
import { CCAgentSessionView } from '@/features/cc-agent/CCAgentSessionView';
import type { ComposerBotMention } from '@/lib/fileTypes';
import { getBotLastReadAt, markBotRead } from './botReadState';
import { getBotProfiles, getBotUnreadCounts } from './botStore';
import type { BotChatIdentity } from './BotSessionContentHeader';
import type { BotChatBinding } from './botChatPresentation';
import { useBotIslandVisibleSession } from './useBotIslandVisibleSession';

type BotSessionGate =
  | { kind: 'loading' }
  | {
      kind: 'ready';
      mentions: ComposerBotMention[];
      identity: BotChatBinding;
      /** True only for the Bot's own canonical chat (not a mounted channel route). */
      isCanonical: boolean;
      /** Read position captured before opening advances it; null when entry had no unread replies. */
      unreadBoundaryAt: number | null;
    }
  | { kind: 'unavailable' }
  | { kind: 'error'; message: string };

interface BotRoutePresentation {
  /** 切换期间暂时落后于地址栏的可见伙伴页面。 */
  routeKey: string;
  botId?: string;
  sessionId?: string;
  gate: BotSessionGate;
}

function botRouteKey(botId: string | undefined, sessionId: string | undefined): string {
  return `${botId ?? ''}:${sessionId ?? ''}`;
}

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
    identity: { ...readBotChatIdentity(bot, botId), sessionId },
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
  return <BotSessionGateView />;
}

function BotSessionGateView() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { botId, sessionId } = useParams();
  const routeKey = botRouteKey(botId, sessionId);
  const [reloadVersion, setReloadVersion] = useState(0);
  // 切伙伴时先保留旧聊天，等新伙伴 gate 完成后一次性替换，避免空白帧。
  const [presentation, setPresentation] = useState<BotRoutePresentation>(() => ({
    routeKey,
    botId,
    sessionId,
    gate: computeFastGate(botId, sessionId) ?? { kind: 'loading' },
  }));
  // 可信的内存投影可以立即切换；没有投影时继续显示旧页面等待 IPC。
  const fastGate = useMemo(
    () => computeFastGate(botId, sessionId),
    [botId, sessionId],
  );
  const visiblePresentation =
    presentation.routeKey === routeKey
      ? presentation
      : fastGate
        ? { routeKey, botId, sessionId, gate: fastGate }
        : presentation;
  const visibleBotId = visiblePresentation.botId;
  const visibleSessionId = visiblePresentation.sessionId;
  const visibleGate = visiblePresentation.gate;
  const isVisibleRouteCurrent = visiblePresentation.routeKey === routeKey;

  useBotIslandVisibleSession(
    visibleGate.kind === 'ready' ? visibleSessionId ?? null : null,
  );

  useEffect(() => {
    let cancelled = false;
    if (!botId || !sessionId) {
      setPresentation({
        routeKey,
        botId,
        sessionId,
        gate: { kind: 'unavailable' },
      });
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
          setPresentation({
            routeKey,
            botId,
            sessionId,
            gate: { kind: 'unavailable' },
          });
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
          setPresentation({
            routeKey,
            botId,
            sessionId,
            gate: { kind: 'unavailable' },
          });
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
        setPresentation((prev) => {
          const nextGate: Extract<BotSessionGate, { kind: 'ready' }> = {
            kind: 'ready',
            // 欢迎语只属于主任务:渠道路由任务是「别处的对话被接进来」,
            // 在那里冒出一句自我介绍是插话,不是打招呼。
            isCanonical: activeProjection?.role === 'canonical',
            unreadBoundaryAt:
              activeProjection?.role === 'canonical' && unreadCount > 0 ? lastReadAt : null,
            identity: { ...readBotChatIdentity(bot, botId), sessionId },
            mentions: Array.isArray(bots)
              ? bots
                  .map((candidate) => readBotMention(candidate, botId))
                  .filter((candidate): candidate is ComposerBotMention => candidate !== null)
              : [],
          };
          if (
            prev.routeKey === routeKey &&
            prev.gate.kind === 'ready' &&
            isSameReadyGate(prev.gate, nextGate)
          ) {
            return prev;
          }
          return { routeKey, botId, sessionId, gate: nextGate };
        });
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        setPresentation({
          routeKey,
          botId,
          sessionId,
          gate: {
            kind: 'error',
            message: error instanceof Error ? error.message : String(error),
          },
        });
      });
    return () => {
      cancelled = true;
    };
  }, [botId, reloadVersion, routeKey, sessionId]);

  // Opening the conversation is what marks it read, and staying in it keeps it
  // read: while this view is mounted every row that lands in the task advances
  // the read position, so a reply the user is watching arrive never turns into
  // an unread badge behind their back.
  useEffect(() => {
    if (visibleGate.kind !== 'ready' || !visibleBotId || !visibleSessionId) return;
    markBotRead(visibleBotId);
    const subscribe = window.electronAPI?.localDb?.messages?.onCreated;
    if (typeof subscribe !== 'function') return;
    const unsubscribe = subscribe((payload: unknown) => {
      const incoming = (payload as { sessionId?: unknown } | null)?.sessionId;
      if (incoming !== visibleSessionId) return;
      markBotRead(visibleBotId);
    });
    return () => {
      unsubscribe?.();
    };
  }, [visibleBotId, visibleGate.kind, visibleSessionId]);

  if (visibleGate.kind === 'loading') {
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
  if (visibleGate.kind !== 'ready' || !visibleSessionId) {
    const failed = visibleGate.kind === 'error';
    return (
      <main
        className="flex h-full items-center justify-center bg-[var(--surface)] p-6"
        aria-busy={!isVisibleRouteCurrent}
      >
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
          {failed && visibleGate.message ? (
            <p className="mt-3 max-h-24 overflow-y-auto whitespace-pre-wrap rounded-lg bg-[var(--surface)] px-3 py-2 text-left text-11 text-[var(--text-danger)] [overflow-wrap:anywhere]">
              {visibleGate.message}
            </p>
          ) : null}
          <div className="mt-4 flex flex-wrap justify-center gap-2">
            <button
              type="button"
              onClick={() => navigate(visibleBotId ? `/bots/${visibleBotId}` : '/bots')}
              className="inline-flex h-9 items-center gap-2 rounded-lg border border-[var(--border-default)] px-3 text-12 text-[var(--text-secondary)] hover:bg-[var(--surface-hover)]"
            >
              <ArrowLeft size={14} />
              {t('bots.backToBot')}
            </button>
            {failed ? (
              <button
                type="button"
                onClick={() => {
                  // 重试当前地址时显示 loading；正常切伙伴不会走这里。
                  setPresentation({
                    routeKey,
                    botId,
                    sessionId,
                    gate: { kind: 'loading' },
                  });
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
    <main
      className={`relative flex h-full min-w-0 overflow-hidden bg-[var(--surface)] ${
        isVisibleRouteCurrent ? '' : 'pointer-events-none'
      }`}
      aria-busy={!isVisibleRouteCurrent}
    >
      <div className="min-w-0 flex-1">
        <CCAgentSessionView
          key={visiblePresentation.routeKey}
          sessionIdProp={visibleSessionId}
          routeOwner
          botMentions={visibleGate.kind === 'ready' ? visibleGate.mentions : undefined}
          botIdentity={visibleGate.kind === 'ready' ? visibleGate.identity : undefined}
          botUnreadBoundaryAt={
            visibleGate.kind === 'ready' ? visibleGate.unreadBoundaryAt : null
          }
        />
      </div>
    </main>
  );
}
