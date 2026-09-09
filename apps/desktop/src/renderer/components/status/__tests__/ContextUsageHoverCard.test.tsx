// @vitest-environment jsdom

import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import type { ContextUsageData } from '@cindy/maker-core';
import type { TurnUsageDetails } from '../../../../shared/turnUsageDetails';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options: Record<string, string | number> = {}) => {
      const translations: Record<string, string> = {
        'chat.systemCard.context.title': '上下文用量',
        'chat.systemCard.context.barAria': '上下文窗口用量',
        'chat.systemCard.context.noCachedDetails': '暂无缓存详情',
        'chat.systemCard.context.deferred': '（延迟加载）',
        'chat.systemCard.context.categories.systemPromptSource': '系统提示词',
        'chat.systemCard.context.categories.toolsSource': '工具',
        'chat.systemCard.context.categories.mcpSource': 'MCP',
        'chat.systemCard.context.categories.skillsSource': '技能',
        'chat.systemCard.context.categories.conversationSource': '对话',
        'chat.systemCard.context.categories.subagentsSource': '子智能体',
        'ccAgent.layout.contextRing.speedLabel': '速度',
        'ccAgent.layout.contextRing.suggestionLabel': '建议',
        'ccAgent.layout.contextRing.hintLabel': '提示',
        'ccAgent.layout.contextRing.tokenSplitTitle': '本轮 token 拆分',
        'ccAgent.layout.contextRing.tokenSplitAria': '本轮 token 拆分进度',
        'ccAgent.layout.contextRing.tokenSplitInput': '输入',
        'ccAgent.layout.contextRing.tokenSplitCacheRead': '缓存读取',
        'ccAgent.layout.contextRing.tokenSplitCacheCreate': '缓存写入',
        'ccAgent.layout.contextRing.tokenSplitOutput': '输出',
        'ccAgent.layout.contextRing.agentUsageTitle': '代理用量',
        'ccAgent.layout.contextRing.agentUsageAgent': '代理',
        'ccAgent.layout.contextRing.agentUsageTokens': 'tokens',
        'ccAgent.layout.contextRing.agentUsageShare': '占比',
        'ccAgent.layout.contextRing.mainAgent': '主代理',
        'ccAgent.layout.contextRing.subAgent': '子代理',
        'ccAgent.layout.contextRing.performanceValue': '{{rate}} token/秒 · 耗时 {{duration}}',
        'ccAgent.layout.contextRing.performanceRateValue': '{{rate}} token/秒',
        'ccAgent.layout.contextRing.performanceTimeValue': '耗时 {{duration}}',
        'usageDetails.durationSeconds': '{{value}}秒',
        'usageDetails.durationMinutesSeconds': '{{minutes}}分 {{seconds}}秒',
        'usageDetails.suggestion.lowCache': '缓存命中率偏低，本轮较多上下文重新计费',
      };
      return (translations[key] ?? key).replace(/{{(\w+)}}/g, (_, name: string) =>
        String(options[name] ?? ''),
      );
    },
  }),
}));

import { ContextUsageHoverCard, ContextUsagePopover } from '../ContextUsageHoverCard';

const USAGE: ContextUsageData = {
  categories: [
    { name: 'System prompt', tokens: 334, color: '#F59E0B' },
    { name: 'Messages', tokens: 2, color: '#3B82F6' },
    { name: 'MCP tools', tokens: 1040, color: '#EC4899' },
    { name: 'Skills', tokens: 326, color: '#14B8A6' },
  ],
  totalTokens: 1702,
  maxTokens: 1_000_000,
  rawMaxTokens: 1_000_000,
  percentage: 0.1702,
  gridRows: [],
  model: 'flash',
  memoryFiles: [],
  mcpTools: [],
  agents: [],
  isAutoCompactEnabled: true,
  apiUsage: null,
};

const TURN_DETAILS: TurnUsageDetails = {
  inputTokens: 62_500,
  outputTokens: 17_600,
  cacheReadTokens: 736_800,
  cacheCreateTokens: 0,
  totalTokens: 816_900,
  durationMs: 266_000,
  turnDurationMs: 268_000,
  cacheHitRate: 0.1,
  model: 'flash',
};

describe('ContextUsageHoverCard', () => {
  it('把 token 拆分放在分割线上方，速度、建议、提示放在下方', () => {
    render(
      <ContextUsageHoverCard
        usage={USAGE}
        fallbackTotalTokens={0}
        fallbackMaxTokens={0}
        latestTurnDetails={TURN_DETAILS}
        hintText="点击压缩上下文"
      />,
    );

    const card = screen.getByTestId('context-usage-hover-card');
    const overview = screen.getByTestId('context-usage-overview');
    const meta = screen.getByTestId('context-usage-meta');

    expect(screen.getByTestId('context-usage-title').textContent).toBe('上下文用量');
    expect(screen.getByText('1.70K / 1M')).toBeTruthy();
    expect(screen.getByRole('progressbar').getAttribute('aria-valuenow')).toBe('0.1702');
    expect(screen.getByTestId('context-usage-divider')).toBeTruthy();
    expect(screen.getByTestId('context-usage-source-divider')).toBeTruthy();
    expect(screen.getByTestId('context-usage-metrics')).toBeTruthy();

    expect(within(overview).getAllByTestId('context-usage-source')).toHaveLength(6);
    expect(within(overview).getByText('系统提示词')).toBeTruthy();
    expect(within(overview).getByText('工具')).toBeTruthy();
    expect(within(overview).getByText('MCP')).toBeTruthy();
    expect(within(overview).getByText('技能')).toBeTruthy();
    expect(within(overview).getByText('对话')).toBeTruthy();
    expect(within(overview).getByText('子智能体')).toBeTruthy();
    expect(screen.getAllByTestId('context-usage-source-segment')).toHaveLength(6);
    expect(screen.getByRole('progressbar').className).toContain('bg-[#3a3a3a]');
    expect(overview.textContent).not.toContain('速度');
    expect(overview.textContent).not.toContain('建议');
    expect(overview.querySelector('[data-testid="context-usage-meta"]')).toBeNull();

    expect(within(meta).getByTestId('context-usage-speed').textContent).toContain(
      '速度66.2 token/秒 · 耗时 4分 28秒',
    );
    expect(within(meta).getByTestId('context-usage-suggestion').textContent).toContain(
      '建议缓存命中率偏低，本轮较多上下文重新计费',
    );
    expect(within(meta).getByTestId('context-usage-hint').textContent).toContain(
      '提示点击压缩上下文',
    );
    expect(card.textContent?.indexOf('速度')).toBeGreaterThan(
      card.textContent?.indexOf('MCP') ?? -1,
    );
  });

  it('没有缓存详情时不触发加载，也不显示正在加载', () => {
    render(
      <ContextUsageHoverCard
        usage={undefined}
        fallbackTotalTokens={1_710}
        fallbackMaxTokens={1_000_000}
      />,
    );

    expect(screen.getByText('1.71K / 1M')).toBeTruthy();
    expect(screen.getByTestId('context-usage-empty').textContent).toContain('暂无缓存详情');
    expect(screen.queryByText('正在加载上下文用量…')).toBeNull();
    expect(screen.queryByTestId('context-usage-divider')).toBeNull();
  });

  it('主代理和子代理分开显示，速度只使用主代理输出', () => {
    const scopedDetails: TurnUsageDetails = {
      inputTokens: 62_500,
      outputTokens: 22_600,
      cacheReadTokens: 736_800,
      cacheCreateTokens: 0,
      totalTokens: 821_900,
      parentUsage: {
        inputTokens: 50_000,
        outputTokens: 17_600,
        cacheReadTokens: 700_000,
        cacheCreateTokens: 0,
        totalTokens: 767_600,
      },
      subagentUsage: {
        inputTokens: 12_500,
        outputTokens: 5_000,
        cacheReadTokens: 36_800,
        cacheCreateTokens: 0,
        totalTokens: 54_300,
      },
      durationMs: 266_000,
      turnDurationMs: 268_000,
      cacheHitRate: 0.1,
      model: 'flash',
    };

    render(
      <ContextUsageHoverCard
        usage={USAGE}
        fallbackTotalTokens={0}
        fallbackMaxTokens={0}
        latestTurnDetails={scopedDetails}
      />,
    );

    const sources = screen.getByTestId('context-usage-sources');
    expect(within(sources).getByText('对话')).toBeTruthy();
    expect(within(sources).getByText('子智能体')).toBeTruthy();
    expect(within(sources).getAllByTestId('context-usage-source')).toHaveLength(6);
    expect(screen.getByTestId('context-usage-metrics')).toBeTruthy();
    expect(within(screen.getByTestId('context-usage-meta')).getByTestId('context-usage-speed').textContent)
      .toContain('速度66.2 token/秒');
  });

  it('鼠标进入圆环只显示已传入的缓存详情', () => {
    render(
      <ContextUsagePopover
        usage={USAGE}
        fallbackTotalTokens={0}
        fallbackMaxTokens={0}
        hintText="来源说明"
        usageKey="session-a"
      >
        <button type="button">查看 token</button>
      </ContextUsagePopover>,
    );

    const trigger = screen.getByRole('button', { name: '查看 token' });
    fireEvent.mouseEnter(trigger.parentElement as HTMLElement);

    expect(screen.getByTestId('context-usage-hover-card')).toBeTruthy();
    expect(screen.getByText('1.70K / 1M')).toBeTruthy();
    expect(screen.getByTestId('context-usage-hint').textContent).toContain('来源说明');
  });
});
