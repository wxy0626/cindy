import type {
  RemoteCollectionItem,
  RemoteLocalizedText,
  RemoteResource,
  RemoteResourceStatus,
} from '@cindy/device-link';

import type { BotRemoteResourceSource } from './bots.js';
import { isBotVisibleRemotely } from './botRemoteVisibility.js';
import { isManagedBotAvatarUrl } from '../../../shared/botAvatarValue.js';

export const TEAMMATES_REMOTE_COLLECTION_ID = 'teammates';
export const BOT_REMOTE_RESOURCE_KIND = 'bot';

export const TEAMMATES_TITLE: RemoteLocalizedText = {
  fallback: 'Teammates',
  translations: {
    'zh-CN': '所有伙伴',
  },
};

const STATUS_COPY: Readonly<Record<string, RemoteResourceStatus>> = {
  active: {
    label: {
      fallback: 'Available',
      translations: { 'zh-CN': '可用' },
    },
    tone: 'positive',
  },
  paused: {
    label: {
      fallback: 'Paused',
      translations: { 'zh-CN': '已暂停' },
    },
    tone: 'neutral',
  },
  archived: {
    label: {
      fallback: 'Archived',
      translations: { 'zh-CN': '已归档' },
    },
    tone: 'neutral',
  },
  error: {
    label: {
      fallback: 'Needs attention',
      translations: { 'zh-CN': '需要关注' },
    },
    tone: 'critical',
  },
  deleting: {
    label: {
      fallback: 'Deleting',
      translations: { 'zh-CN': '删除中' },
    },
    tone: 'neutral',
  },
};

const ATTENTION_COPY: RemoteLocalizedText = {
  fallback: 'Needs attention',
  translations: {
    'zh-CN': '需要关注',
  },
};

function resourceRef(id: string) {
  return {
    collectionId: TEAMMATES_REMOTE_COLLECTION_ID,
    kind: BOT_REMOTE_RESOURCE_KIND,
    id,
  } as const;
}

function sourceRevision(source: BotRemoteResourceSource): string {
  return [
    source.currentVersion,
    source.invitation?.stage ?? '',
    source.updatedAt,
    source.lastMessageAt ?? 0,
    source.lastReplyAt ?? 0,
    source.hiddenAt ?? 0,
    source.pinnedAt ?? 0,
    source.activityAt,
    source.canonicalSessionId ?? '',
    source.needsAttention ? 1 : 0,
  ].join(':');
}

export function botRemoteCollectionItemFromSource(
  source: BotRemoteResourceSource,
): RemoteCollectionItem {
  const fallbackText = Array.from(source.name.trim())[0] ?? 'C';
  const status = source.needsAttention
    ? { label: ATTENTION_COPY, tone: 'warning' as const }
    : STATUS_COPY[source.status] ?? { label: source.status || 'Unknown', tone: 'neutral' };
  return {
    ref: resourceRef(source.id),
    display: {
      title: source.name,
      lastReplyAt: source.lastReplyAt ?? 0,
      ...(source.description ? { subtitle: source.description } : {}),
      ...(source.lastMessagePreview ? { preview: source.lastMessagePreview } : {}),
      ...(source.activityAt ? { timestamp: source.activityAt } : {}),
      avatar: {
        kind: source.avatar.startsWith('cindy://avatar/')
          ? 'asset'
          : isManagedBotAvatarUrl(source.avatar)
            ? 'media'
            : source.avatar
              ? 'emoji'
              : 'text',
        value: source.avatar,
        fallbackText,
        color: source.avatarColor,
      },
      status,
      ...(source.needsAttention
        ? { badges: [{ accessibilityLabel: ATTENTION_COPY, tone: 'warning' as const }] }
        : {}),
    },
    links: source.canonicalSessionId
      ? [{
          rel: 'conversation',
          target: { kind: 'session', sessionId: source.canonicalSessionId },
        }]
      : [],
    revision: sourceRevision(source),
  };
}

/** Match the authoritative desktop roster: hidden rows stay recoverable on desktop only. */
export function visibleBotRemoteResourceSources(
  sources: readonly BotRemoteResourceSource[],
): BotRemoteResourceSource[] {
  return sources
    .filter(isBotVisibleRemotely)
    .sort((left, right) => {
      const pinned = Number(Boolean(right.pinnedAt)) - Number(Boolean(left.pinnedAt));
      return pinned || right.activityAt - left.activityAt || left.id.localeCompare(right.id);
    });
}

export function botRemoteResourceFromSource(source: BotRemoteResourceSource): RemoteResource {
  const blocks: NonNullable<RemoteResource['blocks']> = [];
  if (source.description) blocks.push({ id: 'about', primitive: 'markdown', fallbackMarkdown: source.description });
  if (source.invitation) blocks.push({ id: 'invitation', primitive: 'status', fallbackMarkdown: '', data: { stage: source.invitation.stage } });
  return { ...botRemoteCollectionItemFromSource(source), ...(blocks.length ? { blocks } : {}) };
}
