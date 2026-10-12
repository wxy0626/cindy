// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';

import { decideAgentForTask } from '@/lib/decisionModelClient';
import type { DecisionModelSettings } from '@/state/decisionModelSettings';

const SETTINGS: DecisionModelSettings = {
  version: 2,
  enabled: true,
  endpoint: 'http://127.0.0.1:8765/predict',
  minConfidence: 0.3,
};

/** Laya 四分类的典型响应：最高候选约 0.33，confidence 只是归一化熵。 */
function layaResponse(taskProbability: number) {
  return {
    model: 'laya-rl-agent',
    answers: {
      task_type: {
        type: 'choice',
        choice: 'codex',
        probabilities: {
          codex: taskProbability,
          cc: 0.21,
          pi: 0.28,
          other: 0.18,
        },
        confidence: 0.0244,
      },
      risk: { type: 'score', score: 0.66 },
      needs_review: { type: 'noul', noul: 0.7027 },
    },
  };
}

function mockFetch(probability: number) {
  return vi
    .spyOn(globalThis, 'fetch')
    .mockResolvedValue(
      new Response(JSON.stringify(layaResponse(probability)), { status: 200 }),
    );
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('decideAgentForTask', () => {
  it('keeps a 33% four-way result at the 30% default threshold', async () => {
    mockFetch(0.3349);

    const result = await decideAgentForTask('写一个 Python 脚本处理 CSV', SETTINGS);

    expect(result?.vendor).toBe('codex');
    expect(result?.probability).toBeCloseTo(0.3349, 4);
  });

  it('still rejects results below the configured threshold', async () => {
    mockFetch(0.3349);

    const result = await decideAgentForTask('写一个 Python 脚本处理 CSV', {
      ...SETTINGS,
      minConfidence: 0.5,
    });

    expect(result).toBeNull();
  });

  it('does not gate on entropy confidence', async () => {
    mockFetch(0.45);

    const result = await decideAgentForTask('审计这个复杂项目架构', SETTINGS);

    expect(result?.vendor).toBe('codex');
  });

  it('skips the call entirely when disabled', async () => {
    const fetchSpy = mockFetch(0.9);

    const result = await decideAgentForTask('写一个脚本', { ...SETTINGS, enabled: false });

    expect(result).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
