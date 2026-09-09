/**
 * ContextUsageHoverCard — 会话底部上下文圆环的结构化悬浮详情。
 *
 * 信息层级固定为两段：
 *   1. 分割线以上：上下文总量、进度条和 token 来源拆分；
 *   2. 分割线以下：最近一轮速度、建议和圆环提示。
 *
 * 组件只负责展示调用方传入的快照；数据在对话流程或用户主动执行 /context 时
 * 写入会话状态，悬浮时不发起 IPC 请求。
 */

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type FocusEvent,
  type ReactElement,
} from 'react';
import { useTranslation } from 'react-i18next';

import type { ContextUsageData } from '@cindy/maker-core';

import { Popover, PopoverAnchor, PopoverContent } from '@/components/ui/popover';
import {
  formatOutputTokenRate,
  formatTurnDuration,
  getTurnUsageSuggestion,
} from '@/lib/turnUsageTooltip';
import type { TurnUsageDetails } from '../../../shared/turnUsageDetails';

/** 悬浮卡片需要的上下文快照与最近一轮展示数据。 */
export interface ContextUsageHoverCardProps {
  /** 已缓存的完整上下文详情；缺失时仍使用圆环快照显示总量和进度条。 */
  usage?: ContextUsageData | null;
  fallbackTotalTokens: number;
  fallbackMaxTokens: number;
  /** 最近一轮 assistant usage，用于分割线下的速度与建议。 */
  latestTurnDetails?: TurnUsageDetails | null;
  /** 分割线下的提示文案，例如 Pi 来源说明或手动压缩提示。 */
  hintText?: string | null;
}

/** 悬浮容器的完整参数；children 是现有的圆环按钮或展示节点。 */
export interface ContextUsagePopoverProps extends ContextUsageHoverCardProps {
  /** 会话、模型或远程设备变化时清空旧快照，避免短暂显示上一任务的数据。 */
  usageKey?: string;
  children: ReactElement;
}

/** 有限非负数，避免脏 IPC 数据破坏进度条布局。 */
function finiteNonNegative(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.max(0, value) : 0;
}

/** 把百分比限制在进度条可接受的范围内。 */
function clampPercent(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(100, Math.max(0, value));
}

/** 以紧凑格式显示上下文 token，保留两位小数以便小用量也可读。 */
function formatContextTokens(value: number): string {
  const tokens = finiteNonNegative(value);
  if (tokens >= 1_000_000) {
    const millions = tokens / 1_000_000;
    return (
      (Number.isInteger(millions) ? String(millions) : millions.toFixed(2).replace(/\.00$/, '')) +
      'M'
    );
  }
  if (tokens >= 1_000) {
    const thousands = tokens / 1_000;
    return (
      (Number.isInteger(thousands)
        ? String(thousands)
        : thousands.toFixed(2).replace(/\.00$/, '')) + 'K'
    );
  }
  return String(Math.round(tokens));
}

/** 显示来源占已用上下文的百分比，而不是占整个容量的百分比。 */
function formatCategoryPercent(tokens: number, totalTokens: number): string {
  if (totalTokens <= 0) return '0.0%';
  return ((finiteNonNegative(tokens) / totalTokens) * 100).toFixed(1) + '%';
}

/** 把新旧消息中的未知 usage 字段收敛为可展示的有限 token 数。 */
function readUsageTokens(value: unknown): number {
  if (typeof value === 'number') return finiteNonNegative(value);
  if (!value || typeof value !== 'object' || Array.isArray(value)) return 0;

  const record = value as Record<string, unknown>;
  const nestedUsage = record.usage;
  if (nestedUsage !== undefined && nestedUsage !== value) {
    const nestedTokens = readUsageTokens(nestedUsage);
    if (nestedTokens > 0) return nestedTokens;
  }
  for (const key of ['totalTokens', 'tokens', 'tokenCount', 'total']) {
    const tokens = finiteNonNegative(record[key]);
    if (tokens > 0) return tokens;
  }

  return ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheCreateTokens'].reduce(
    (sum, key) => sum + finiteNonNegative(record[key]),
    0,
  );
}

/** 读取上下文快照中的分类 token，兼容不同版本的字段命名。 */
function sumContextCategoryTokens(
  usage: ContextUsageData,
  names: string[],
): number {
  return usage.categories
    .filter((category) => names.includes(category.name))
    .reduce((sum, category) => sum + finiteNonNegative(category.tokens), 0);
}

/** 将详情中的代理桶按四类 token 求和。 */
function usageBucketTotal(value: unknown): number {
  return readUsageTokens(value);
}

/** 把 SDK 快照统一成图示中的六类来源，并保持固定顺序。 */
function readContextSourceRows(
  usage: ContextUsageData | null,
  details: TurnUsageDetails | null,
): Array<{ kind: string; labelKey: string; tokens: number; color: string }> {
  const hasCategories = Boolean(usage && usage.categories.length > 0);
  const rows = [
    {
      kind: 'system-prompt',
      labelKey: 'systemPromptSource',
      tokens: hasCategories
        ? sumContextCategoryTokens(usage!, ['System prompt'])
        : usage
          ? (usage.systemPromptSections ?? []).reduce((sum, item) => sum + finiteNonNegative(item.tokens), 0)
        : 0,
      color: '#6366F1',
    },
    {
      kind: 'tools',
      labelKey: 'toolsSource',
      tokens: hasCategories
        ? sumContextCategoryTokens(usage!, ['System tools', '[ANT-ONLY] System tools', 'System tools (deferred)'])
        : usage
          ? (usage.systemTools ?? []).reduce((sum, item) => sum + finiteNonNegative(item.tokens), 0)
        : 0,
      color: '#10B981',
    },
    {
      kind: 'mcp',
      labelKey: 'mcpSource',
      tokens: hasCategories
        ? sumContextCategoryTokens(usage!, ['MCP tools', 'MCP tools (deferred)'])
        : usage
          ? usage.mcpTools.reduce((sum, item) => sum + finiteNonNegative(item.tokens), 0)
        : 0,
      color: '#EC4899',
    },
    {
      kind: 'skills',
      labelKey: 'skillsSource',
      tokens: hasCategories
        ? sumContextCategoryTokens(usage!, ['Skills'])
        : usage
          ? usage.skills?.tokens ?? 0
        : 0,
      color: '#8B5CF6',
    },
    {
      kind: 'conversation',
      labelKey: 'conversationSource',
      tokens: hasCategories
        ? sumContextCategoryTokens(usage!, ['Messages'])
        : usage
          ? (usage.messageBreakdown?.userMessageTokens ?? 0) +
            (usage.messageBreakdown?.assistantMessageTokens ?? 0) +
            (usage.messageBreakdown?.attachmentTokens ?? 0)
        : 0,
      color: '#F59E0B',
    },
    {
      kind: 'subagents',
      labelKey: 'subagentsSource',
      tokens: hasCategories
        ? sumContextCategoryTokens(usage!, ['Custom agents', 'Agents', 'Subagents'])
        : usage
          ? usage.agents.reduce((sum, item) => sum + finiteNonNegative(item.tokens), 0)
        : 0,
      color: '#14B8A6',
    },
  ];

  // 对没有来源分类的历史消息，用 token 事实把用量保留在对话/子智能体两类中。
  if ((!usage || !hasCategories) && details) {
    const record = details as unknown as Record<string, unknown>;
    rows[4].tokens = finiteNonNegative(details.totalTokens) - usageBucketTotal(record.subagentUsage);
    rows[5].tokens = usageBucketTotal(record.subagentUsage);
  } else if (details) {
    // 上下文快照可能没有 agents 分类，但本轮用量仍携带了子智能体桶。
    const subagentTokens = usageBucketTotal(
      (details as unknown as Record<string, unknown>).subagentUsage,
    );
    rows[5].tokens = Math.max(rows[5].tokens, subagentTokens);
  }
  return rows.map((row) => ({ ...row, tokens: finiteNonNegative(row.tokens) }));
}

/** 显示图示风格的六类来源列表；零值也保留，避免来源行跳动。 */
function ContextUsageSourceDetails({
  usage,
  details,
}: {
  usage: ContextUsageData | null;
  details?: TurnUsageDetails | null;
}) {
  const { t } = useTranslation();
  const rows = readContextSourceRows(usage, details ?? null);
  const total = rows.reduce((sum, row) => sum + row.tokens, 0);
  return (
    <div data-testid="context-usage-sources" className="mt-3 flex flex-col gap-2">
      {rows.map((row) => (
        <div
          key={row.kind}
          data-testid="context-usage-source"
          data-source={row.kind}
          className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-3 text-12"
        >
          <div className="flex min-w-0 items-center gap-2">
            <span
              aria-hidden="true"
              className="h-2 w-2 shrink-0 rounded-full"
              style={{ backgroundColor: row.color }}
            />
            <span className="truncate text-[var(--text-secondary)]">
              {t('chat.systemCard.context.categories.' + row.labelKey)}
            </span>
          </div>
          <span className="shrink-0 tabular-nums text-[var(--text-secondary)]">
            {formatCategoryPercent(row.tokens, total)}
          </span>
        </div>
      ))}
    </div>
  );
}

/** 按用户指定的四格顺序展示本轮 token：左侧输入/输出，右侧缓存写入/读取。 */
function ContextUsageMetrics({ details }: { details?: TurnUsageDetails | null }) {
  const { t } = useTranslation();
  if (!details) return null;
  const metrics = [
    { kind: 'input', labelKey: 'tokenSplitInput', tokens: details.inputTokens, color: '#F97316' },
    {
      kind: 'cacheCreate',
      labelKey: 'tokenSplitCacheCreate',
      tokens: details.cacheCreateTokens,
      color: '#F59E0B',
    },
    { kind: 'output', labelKey: 'tokenSplitOutput', tokens: details.outputTokens, color: '#3B82F6' },
    {
      kind: 'cacheRead',
      labelKey: 'tokenSplitCacheRead',
      tokens: details.cacheReadTokens,
      color: '#14B8A6',
    },
  ];
  return (
    <div data-testid="context-usage-metrics" className="mt-3 grid grid-cols-2 gap-x-4 gap-y-1.5 text-12">
      {metrics.map((metric) => (
        <div key={metric.kind} className="flex min-w-0 items-center justify-between gap-2">
          <span className="flex min-w-0 items-center gap-1.5 text-[var(--text-secondary)]">
            <span
              aria-hidden="true"
              className="h-1.5 w-1.5 shrink-0 rounded-full"
              style={{ backgroundColor: metric.color }}
            />
            <span className="truncate">
              {t('ccAgent.layout.contextRing.' + metric.labelKey)}
            </span>
          </span>
          <span className="shrink-0 tabular-nums text-[var(--text-primary)]">
            {formatContextTokens(finiteNonNegative(metric.tokens))}
          </span>
        </div>
      ))}
    </div>
  );
}

/** 分割线下的最近一轮信息，只在确实有数据时显示。 */
function ContextUsageMeta({
  details,
  hintText,
}: {
  details?: TurnUsageDetails | null;
  hintText?: string | null;
}) {
  const { t } = useTranslation();
  const outputRate = details ? formatOutputTokenRate(details) : null;
  const duration =
    details && typeof details.turnDurationMs === 'number'
      ? formatTurnDuration(details.turnDurationMs, t)
      : null;
  const performanceText =
    outputRate && duration
      ? t('ccAgent.layout.contextRing.performanceValue', { rate: outputRate, duration })
      : outputRate
        ? t('ccAgent.layout.contextRing.performanceRateValue', { rate: outputRate })
        : duration
          ? t('ccAgent.layout.contextRing.performanceTimeValue', { duration })
          : null;
  const suggestionText = details ? getTurnUsageSuggestion(details, t) : null;
  const hasMeta = Boolean(performanceText || suggestionText || hintText);
  if (!hasMeta) return null;

  return (
    <section
      data-testid="context-usage-meta"
      className="space-y-1.5 px-4 pb-3 pt-2 text-12 leading-[1.4]"
    >
      {performanceText ? (
        <div
          data-testid="context-usage-speed"
          className="flex items-baseline justify-between gap-3"
        >
          <span className="shrink-0 text-[var(--text-secondary)]">
            {t('ccAgent.layout.contextRing.speedLabel')}
          </span>
          <span className="min-w-0 text-right tabular-nums text-[var(--text-primary)]">
            {performanceText}
          </span>
        </div>
      ) : null}
      {suggestionText ? (
        <div
          data-testid="context-usage-suggestion"
          className="flex items-baseline justify-between gap-3"
        >
          <span className="shrink-0 text-[var(--text-secondary)]">
            {t('ccAgent.layout.contextRing.suggestionLabel')}
          </span>
          <span className="min-w-0 text-right text-[var(--text-primary)]">{suggestionText}</span>
        </div>
      ) : null}
      {hintText ? (
        <div data-testid="context-usage-hint" className="flex items-baseline justify-between gap-3">
          <span className="shrink-0 text-[var(--text-secondary)]">
            {t('ccAgent.layout.contextRing.hintLabel')}
          </span>
          <span className="min-w-0 text-right text-[var(--text-secondary)]">{hintText}</span>
        </div>
      ) : null}
    </section>
  );
}

/**
 * Render the two-level context usage card. Categories intentionally stay above
 * the divider so speed, suggestion, and hint can never be mistaken for token
 * sources.
 */
export function ContextUsageHoverCard({
  usage,
  fallbackTotalTokens,
  fallbackMaxTokens,
  latestTurnDetails = null,
  hintText = null,
}: ContextUsageHoverCardProps) {
  const { t } = useTranslation();
  const liveUsage = usage ?? null;
  const totalTokens = liveUsage
    ? finiteNonNegative(liveUsage.totalTokens)
    : finiteNonNegative(fallbackTotalTokens);
  const maxTokens = liveUsage
    ? finiteNonNegative(liveUsage.rawMaxTokens || liveUsage.maxTokens)
    : finiteNonNegative(fallbackMaxTokens);
  const sourceRows = readContextSourceRows(liveUsage, latestTurnDetails);
  const sourceTotal = sourceRows.reduce((sum, row) => sum + row.tokens, 0);
  const outputRate = latestTurnDetails ? formatOutputTokenRate(latestTurnDetails) : null;
  const duration =
    latestTurnDetails && typeof latestTurnDetails.turnDurationMs === 'number'
      ? formatTurnDuration(latestTurnDetails.turnDurationMs, t)
      : null;
  const suggestion = latestTurnDetails ? getTurnUsageSuggestion(latestTurnDetails, t) : null;
  const percent =
    maxTokens > 0
      ? clampPercent((totalTokens / maxTokens) * 100)
      : liveUsage
        ? clampPercent(finiteNonNegative(liveUsage.percentage))
        : 0;
  const hasLowerSection = Boolean(outputRate || duration || suggestion || hintText);

  return (
    <div
      data-testid="context-usage-hover-card"
      className="w-[440px] max-w-[calc(100vw-24px)] overflow-hidden rounded-xl border border-[var(--border-default)] bg-[var(--surface-elevated)] text-13 leading-5 text-[var(--text-primary)]"
      style={{ boxShadow: 'var(--shadow-menu)' }}
    >
      <section data-testid="context-usage-overview" className="px-4 pb-2 pt-3">
        <div className="flex items-center justify-between gap-3">
          <span data-testid="context-usage-title" className="text-15 font-semibold">
            {t('chat.systemCard.context.title')}
          </span>
          <span className="shrink-0 tabular-nums text-12 text-[var(--text-secondary)]">
            {percent.toFixed(1)}%
          </span>
        </div>
        <div className="mt-1 tabular-nums text-13 text-[var(--text-secondary)]">
          {formatContextTokens(totalTokens)} / {formatContextTokens(maxTokens)}
        </div>
        <ContextUsageMetrics details={latestTurnDetails} />
        <div
          role="progressbar"
          aria-label={t('chat.systemCard.context.barAria')}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={percent}
          className="mt-3 flex h-2 w-full overflow-hidden rounded-full bg-[#3a3a3a]"
        >
          {sourceRows.map((row) => (
            <span
              key={row.kind}
              data-testid="context-usage-source-segment"
              className="h-full min-w-0 transition-[width] duration-200"
              style={{
                width: sourceTotal > 0 ? (row.tokens / sourceTotal) * percent + '%' : '0%',
                backgroundColor: row.color,
              }}
            />
          ))}
        </div>

        {!usage ? (
          <div
            data-testid="context-usage-empty"
            className="mt-2 text-12 text-[var(--text-secondary)]"
          >
            {t('chat.systemCard.context.noCachedDetails')}
          </div>
        ) : null}

        <div
          data-testid="context-usage-source-divider"
          aria-hidden="true"
          className="mt-3 h-px w-full bg-[var(--border-default)]"
        />
        <ContextUsageSourceDetails usage={liveUsage} details={latestTurnDetails} />
      </section>

      {hasLowerSection ? (
        <>
          <div
            data-testid="context-usage-divider"
            aria-hidden="true"
            className="mx-4 h-px bg-[var(--border-default)]"
          />
          <ContextUsageMeta details={latestTurnDetails} hintText={hintText} />
        </>
      ) : null}
    </div>
  );
}

/**
 * Hover/focus controller for the context card. The anchor is separate from a
 * click trigger so clicking the existing compact button cannot accidentally
 * toggle the details card or change compact behavior.
 */
export function ContextUsagePopover({
  usageKey,
  children,
  ...cardProps
}: ContextUsagePopoverProps) {
  const [open, setOpen] = useState(false);
  const closeTimerRef = useRef<number | null>(null);
  const pointerInsideRef = useRef(false);

  /** 清除悬浮卡关闭计时器。 */
  const clearCloseTimer = useCallback(() => {
    if (closeTimerRef.current === null) return;
    window.clearTimeout(closeTimerRef.current);
    closeTimerRef.current = null;
  }, []);

  /** 在触发节点和 portal 卡片都离开后再关闭，避免跨 portal 移动时闪烁。 */
  const scheduleClose = useCallback(() => {
    clearCloseTimer();
    closeTimerRef.current = window.setTimeout(() => {
      closeTimerRef.current = null;
      if (!pointerInsideRef.current) setOpen(false);
    }, 180);
  }, [clearCloseTimer]);

  /** 进入触发节点时只打开卡片，详情始终读取调用方传入的缓存快照。 */
  const handleAnchorEnter = useCallback(() => {
    pointerInsideRef.current = true;
    clearCloseTimer();
    setOpen(true);
  }, [clearCloseTimer]);

  /** 进入卡片内容后保持打开。 */
  const handleContentEnter = useCallback(() => {
    pointerInsideRef.current = true;
    clearCloseTimer();
  }, [clearCloseTimer]);

  /** 指针离开任一部分时延迟关闭。 */
  const handlePointerLeave = useCallback(() => {
    pointerInsideRef.current = false;
    scheduleClose();
  }, [scheduleClose]);

  /** 键盘焦点进入触发节点时与鼠标保持相同的可见状态。 */
  const handleAnchorFocus = useCallback(() => {
    handleAnchorEnter();
  }, [handleAnchorEnter]);

  /** 焦点仍在圆环内部时不关闭，离开组件后才收起。 */
  const handleAnchorBlur = useCallback(
    (event: FocusEvent<HTMLDivElement>) => {
      const relatedTarget = event.relatedTarget;
      if (relatedTarget instanceof Node && event.currentTarget.contains(relatedTarget)) return;
      handlePointerLeave();
    },
    [handlePointerLeave],
  );

  useEffect(() => {
    setOpen(false);
  }, [usageKey]);

  useEffect(() => {
    return () => {
      clearCloseTimer();
    };
  }, [clearCloseTimer]);

  return (
    <Popover
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen) setOpen(false);
      }}
      modal={false}
    >
      <PopoverAnchor asChild>
        <div
          className="inline-flex shrink-0"
          onMouseEnter={handleAnchorEnter}
          onMouseLeave={handlePointerLeave}
          onFocusCapture={handleAnchorFocus}
          onBlurCapture={handleAnchorBlur}
        >
          {children}
        </div>
      </PopoverAnchor>
      <PopoverContent
        side="top"
        align="end"
        sideOffset={8}
        onMouseEnter={handleContentEnter}
        onMouseLeave={handlePointerLeave}
        onOpenAutoFocus={(event) => event.preventDefault()}
        onCloseAutoFocus={(event) => event.preventDefault()}
        className="w-auto border-0 bg-transparent p-0 shadow-none"
      >
        <ContextUsageHoverCard {...cardProps} />
      </PopoverContent>
    </Popover>
  );
}
