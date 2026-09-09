/**
 * ToolsSection —— 设置 → 工具 页顶部的「外部 / 内置」分段切换。
 *
 * 工具页把两套来源归拢成两段:「外部工具」切换出用户自定义 MCP 服务器,
 * 排在首位;「内置工具」收纳内置 Agent 工具(含默认值 / 项目覆盖)。两段
 * 常驻挂载、用 hidden 切换,避免反复挂载丢失滚动位置。分段控件样式对齐
 * BrowserBackendSubsection (design-rules §5 Tab Pills)。
 */

import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { cn } from '@/lib/utils';
import { BuiltinToolsSection } from './BuiltinToolsSection';
import { McpServersSection } from './McpServersSection';

type ToolGroup = 'builtin' | 'external';

export function ToolsSection({ workingDir }: { workingDir?: string }) {
  const { t } = useTranslation();
  const [group, setGroup] = useState<ToolGroup>('builtin');

  return (
    <div className="flex flex-col gap-[14px]">
      {/* 分段切换:外部工具 / 内置工具 */}
      <div
        className="plugin-motion-tabs inline-flex shrink-0 rounded-full border p-0.5 backdrop-blur-md"
        style={{
          background: 'color-mix(in srgb, var(--surface-chip) 62%, transparent)',
          borderColor: 'color-mix(in srgb, var(--border-default) 52%, transparent)',
          boxShadow: 'inset 0 1px 0 color-mix(in srgb, var(--surface-elevated) 24%, transparent)',
        }}
        role="tablist"
        aria-label={t('settings.builtinTools.title')}
      >
        <button
          type="button"
          role="tab"
          aria-selected={group === 'external'}
          onClick={() => setGroup('external')}
          className={cn(
            'plugin-management-tab h-8 min-w-[88px] select-none rounded-full border border-transparent px-4 text-13 font-medium transition-colors',
            'focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]',
            group === 'external'
              ? 'plugin-motion-selected text-[var(--text-primary)]'
              : 'border-transparent font-normal text-[var(--text-secondary)] hover:text-[var(--text-primary)]',
          )}
        >
          {t('settings.mcp.title')}
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={group === 'builtin'}
          onClick={() => setGroup('builtin')}
          className={cn(
            'plugin-management-tab h-8 min-w-[88px] select-none rounded-full border border-transparent px-4 text-13 font-medium transition-colors',
            'focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]',
            group === 'builtin'
              ? 'plugin-motion-selected text-[var(--text-primary)]'
              : 'border-transparent font-normal text-[var(--text-secondary)] hover:text-[var(--text-primary)]',
          )}
        >
          {t('settings.builtinTools.title')}
        </button>
      </div>

      {/* 内置工具分组(默认) */}
      <div className={group === 'builtin' ? undefined : 'hidden'}>
        <BuiltinToolsSection workingDir={workingDir} />
      </div>

      {/* 外部工具分组(用户自定义 MCP,自带标题与卡片,原样承接) */}
      <div className={group === 'external' ? undefined : 'hidden'}>
        <McpServersSection />
      </div>
    </div>
  );
}
