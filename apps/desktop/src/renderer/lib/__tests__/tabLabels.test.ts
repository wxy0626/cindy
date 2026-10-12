import { describe, expect, it } from 'vitest';

import { isSettingsTab, TAB_IDS } from '@/lib/tabLabels';

describe('Settings tab order', () => {
  it('places decision model immediately after model providers', () => {
    const providersIndex = TAB_IDS.indexOf('providers');

    expect(TAB_IDS.slice(providersIndex, providersIndex + 2)).toEqual([
      'providers',
      'decision-model',
    ]);
  });

  it('places billing immediately after decision model', () => {
    const decisionModelIndex = TAB_IDS.indexOf('decision-model');

    expect(TAB_IDS.slice(decisionModelIndex, decisionModelIndex + 2)).toEqual([
      'decision-model',
      'billing',
    ]);
  });

  it('places usage history immediately after billing', () => {
    const billingIndex = TAB_IDS.indexOf('billing');

    expect(TAB_IDS.slice(billingIndex, billingIndex + 2)).toEqual(['billing', 'usage']);
  });

  it('keeps Pi extensions inside General instead of exposing a top-level tab', () => {
    expect(TAB_IDS).not.toContain('pi-extensions');
    expect(isSettingsTab('pi-extensions')).toBe(false);
  });

  it('places Plugins immediately before builtin tools', () => {
    const toolsIndex = TAB_IDS.indexOf('builtin-tools');

    expect(TAB_IDS.slice(toolsIndex - 1, toolsIndex + 1)).toEqual(['ghosts', 'builtin-tools']);
  });
});
