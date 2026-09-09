import type { ContextUsageData } from '@cindy/maker-core';

/** 判断未知 IPC / systemCard 数据是否为可展示的上下文详情快照。 */
export function isContextUsageData(value: unknown): value is ContextUsageData {
  if (!value || typeof value !== 'object') return false;

  const usage = value as {
    categories?: unknown;
    totalTokens?: unknown;
    maxTokens?: unknown;
    rawMaxTokens?: unknown;
    percentage?: unknown;
    model?: unknown;
  };
  const categories = usage.categories;

  return (
    Array.isArray(categories) &&
    categories.every((category) => {
      if (!category || typeof category !== 'object') return false;
      const item = category as { name?: unknown; tokens?: unknown; color?: unknown };
      return (
        typeof item.name === 'string' &&
        typeof item.tokens === 'number' &&
        Number.isFinite(item.tokens) &&
        typeof item.color === 'string'
      );
    }) &&
    typeof usage.totalTokens === 'number' &&
    Number.isFinite(usage.totalTokens) &&
    typeof usage.maxTokens === 'number' &&
    Number.isFinite(usage.maxTokens) &&
    typeof usage.rawMaxTokens === 'number' &&
    Number.isFinite(usage.rawMaxTokens) &&
    typeof usage.percentage === 'number' &&
    Number.isFinite(usage.percentage) &&
    typeof usage.model === 'string'
  );
}
