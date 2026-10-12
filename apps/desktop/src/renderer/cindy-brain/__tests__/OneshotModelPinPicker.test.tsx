// @vitest-environment jsdom

import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

const OPENROUTER_PIN = 'cat:openrouter:codex:openai/gpt-5-mini';
const ANTHROPIC_PIN = 'cat:anthropic:claude-code:claude-haiku-4-5';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) =>
      ({
        'settings.auxiliaryModels.backToAgents': 'Back to agents',
        'settings.auxiliaryModels.chooseAgent': 'Choose Agent',
        'settings.auxiliaryModels.unavailable': 'Unavailable',
        'settings.ghosts.detail.cindyPrefs.searchPlaceholder': 'Search models',
        'settings.providers.models.subscription': 'Subscription',
      })[key] ?? key,
  }),
}));

vi.mock('@/components/ui/popover', () => ({
  Popover: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  PopoverTrigger: ({ children }: { children: React.ReactNode }) => children,
  PopoverContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

vi.mock('@/components/new-chat/ModelSelector', () => ({
  ModelSelector: () => null,
  ModelIconMark: () => <span data-testid="model-icon" />,
}));

import { OneshotModelPinPicker, type OneshotPinOption } from '../OneshotModelPinPicker';

const options: OneshotPinOption[] = [
  {
    id: OPENROUTER_PIN,
    label: 'GPT-5 mini · OpenRouter',
    group: 'OpenRouter',
    providerId: 'openrouter',
    agentKind: 'codex',
    modelId: 'openai/gpt-5-mini',
    modelName: 'GPT-5 mini',
    budget: false,
    subscription: false,
    available: true,
  },
  {
    id: ANTHROPIC_PIN,
    label: 'Claude Haiku 4.5 · Anthropic',
    group: 'Anthropic',
    providerId: 'anthropic',
    agentKind: 'claude-code',
    modelId: 'claude-haiku-4-5',
    modelName: 'Claude Haiku 4.5',
    budget: false,
    subscription: false,
    available: true,
  },
];

const xdOption: OneshotPinOption = {
  id: 'cat:xd:codex:deepseek/deepseek-v4-flash',
  label: 'DeepSeek V4 Flash · XD Gateway',
  group: 'XD Gateway',
  providerId: 'xd',
  agentKind: 'codex',
  modelId: 'deepseek/deepseek-v4-flash',
  modelName: 'DeepSeek V4 Flash',
  budget: false,
  subscription: false,
  available: true,
};

function mount(extra: Record<string, unknown> = {}) {
  return render(
    <OneshotModelPinPicker
      defaultLabel="Automatic"
      declaredLabel={null}
      options={options}
      onChange={vi.fn()}
      ariaLabel="Auxiliary model"
      {...extra}
    />,
  );
}

describe('OneshotModelPinPicker Agent-first adapter', () => {
  it('starts from host-approved Agent choices and then reveals only that Agent routes', () => {
    mount();

    expect(screen.getByRole('button', { name: 'Auxiliary model' })).toBeTruthy();
    expect(screen.getByRole('option', { name: 'Codex' })).toBeTruthy();
    expect(screen.getByRole('option', { name: 'Claude Code' })).toBeTruthy();
    expect(screen.queryByText('GPT-5 mini')).toBeNull();

    fireEvent.click(screen.getByRole('option', { name: 'Codex' }));

    expect(screen.getByText('OpenRouter')).toBeTruthy();
    expect(screen.getByText('GPT-5 mini')).toBeTruthy();
    expect(screen.queryByText('Claude Haiku 4.5')).toBeNull();
  });

  it('keeps provider grouping and returns the exact selected provider/Harness pin', () => {
    const onChange = vi.fn();
    mount({ onChange });

    fireEvent.click(screen.getByRole('option', { name: 'Claude Code' }));
    expect(screen.getByText('Anthropic')).toBeTruthy();
    fireEvent.click(screen.getByRole('option', { name: /Claude Haiku 4\.5/ }));

    expect(onChange).toHaveBeenCalledWith(ANTHROPIC_PIN);
  });

  it('does not offer unavailable sibling routes and treats the current stale route as a no-op', () => {
    const onChange = vi.fn();
    const unavailableCurrent = { ...xdOption, available: false };
    const unavailableSibling = {
      ...xdOption,
      id: 'cat:xd:codex:hidden-model',
      modelId: 'hidden-model',
      modelName: 'Hidden model',
      available: false,
    };
    mount({
      value: unavailableCurrent.id,
      options: [unavailableCurrent, unavailableSibling, ...options],
      onChange,
    });

    fireEvent.click(screen.getByRole('option', { name: 'Codex' }));

    expect(screen.getAllByText('Unavailable').length).toBeGreaterThan(0);
    expect(screen.queryByText('Hidden model')).toBeNull();
    fireEvent.click(screen.getByRole('option', { name: /DeepSeek V4 Flash/ }));
    expect(onChange).not.toHaveBeenCalled();
  });

  it('keeps the legacy pin label and allows returning to the automatic route', () => {
    const onChange = vi.fn();
    mount({ value: 'legacy', legacyPinLabel: 'Budget tier', onChange });

    expect(screen.getByRole('button', { name: 'Auxiliary model' }).textContent).toContain(
      'Budget tier',
    );
    fireEvent.click(screen.getByRole('option', { name: /defaultOption/ }));

    expect(onChange).toHaveBeenCalledWith(null);
  });
});
