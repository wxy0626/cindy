import { describe, expect, it } from 'vitest';

import {
  aggregateTurnUsageDetails,
  buildTurnUsageDetails,
  mergeTurnUsageDetailsForMessage,
} from '../turnUsageDetails';
import { DEFAULT_USAGE_CURRENCY, gatewayMoney, usdMoney } from '../regionalMoney';

describe('aggregateTurnUsageDetails', () => {
  it('keeps parent and subagent buckets separate while exposing their sum at the top level', () => {
    const details = buildTurnUsageDetails({
      parentUsage: {
        inputTokens: 100,
        outputTokens: 20,
        cacheReadTokens: 900,
        cacheCreateTokens: 5,
      },
      subagentUsage: {
        inputTokens: 40,
        outputTokens: 8,
        cacheReadTokens: 300,
        cacheCreateTokens: 2,
      },
      durationMs: 1_000,
    });

    expect(details).toMatchObject({
      inputTokens: 140,
      outputTokens: 28,
      cacheReadTokens: 1_200,
      cacheCreateTokens: 7,
      totalTokens: 1_375,
      parentUsage: {
        inputTokens: 100,
        outputTokens: 20,
        cacheReadTokens: 900,
        cacheCreateTokens: 5,
        totalTokens: 1_025,
      },
      subagentUsage: {
        inputTokens: 40,
        outputTokens: 8,
        cacheReadTokens: 300,
        cacheCreateTokens: 2,
        totalTokens: 350,
      },
    });
  });

  it('treats legacy top-level usage as parent usage', () => {
    const details = buildTurnUsageDetails({
      inputTokens: 100,
      outputTokens: 20,
      cacheReadTokens: 300,
      cacheCreateTokens: 2,
    });

    expect(details?.parentUsage).toMatchObject({
      inputTokens: 100,
      outputTokens: 20,
      cacheReadTokens: 300,
      cacheCreateTokens: 2,
      totalTokens: 422,
    });
    expect(details?.subagentUsage).toBeUndefined();
  });

  it('sums token/cache fields and merges per-model costs across segments', () => {
    const first = buildTurnUsageDetails({
      inputTokens: 10,
      outputTokens: 20,
      cacheReadTokens: 100,
      cacheCreateTokens: 5,
      durationMs: 1_000,
      turnDurationMs: 2_000,
      model: 'claude-fable-5[1m]',
      perModelCost: [{ model: 'claude-fable-5', money: usdMoney(2.5) }],
    });
    const second = buildTurnUsageDetails({
      inputTokens: 3,
      outputTokens: 7,
      cacheReadTokens: 50,
      cacheCreateTokens: 2,
      durationMs: 500,
      turnDurationMs: 6_500,
      models: ['claude-fable-5[1m]', 'claude-opus-5[1m]'],
      perModelCost: [
        { model: 'claude-fable-5', money: usdMoney(1.25) },
        { model: 'claude-opus-5', money: usdMoney(4) },
      ],
    });

    const aggregated = aggregateTurnUsageDetails([first, second]);
    expect(aggregated).toMatchObject({
      inputTokens: 13,
      outputTokens: 27,
      cacheReadTokens: 150,
      cacheCreateTokens: 7,
      totalTokens: 197,
      durationMs: 1_500,
      turnDurationMs: 6_500,
      models: ['claude-fable-5[1m]', 'claude-opus-5[1m]'],
    });
    expect(aggregated?.perModelCost).toEqual([
      { model: 'claude-fable-5', money: usdMoney(3.75) },
      { model: 'claude-opus-5', money: usdMoney(4) },
    ]);
    expect(aggregated?.cacheHitRate).toBeCloseTo(150 / 170);
  });

  it('omits aggregate generation timing when any output segment lacks timing', () => {
    const timed = buildTurnUsageDetails({ outputTokens: 20, durationMs: 1_000 });
    const untimed = buildTurnUsageDetails({ outputTokens: 10 });

    expect(aggregateTurnUsageDetails([timed, untimed])).not.toHaveProperty('durationMs');
  });

  it('does not require timing for segments that contribute no output tokens', () => {
    const timed = buildTurnUsageDetails({ outputTokens: 20, durationMs: 1_000 });
    const inputOnly = buildTurnUsageDetails({ inputTokens: 10, durationMs: 500 });

    expect(aggregateTurnUsageDetails([timed, inputOnly])).toMatchObject({ durationMs: 1_000 });
  });

  it('keeps a complete wall clock from a tokenless terminal segment', () => {
    const generated = buildTurnUsageDetails({
      outputTokens: 20,
      durationMs: 1_000,
      turnDurationMs: 2_000,
    });
    const terminal = buildTurnUsageDetails({ turnDurationMs: 6_500 });

    expect(terminal).toMatchObject({ totalTokens: 0, turnDurationMs: 6_500 });
    expect(aggregateTurnUsageDetails([generated, terminal])).toMatchObject({
      outputTokens: 20,
      durationMs: 1_000,
      turnDurationMs: 6_500,
    });
  });

  it('aggregates both agent buckets and keeps generation speed parent-only', () => {
    const aggregated = aggregateTurnUsageDetails([
      buildTurnUsageDetails({
        parentUsage: { outputTokens: 100 },
        durationMs: 2_000,
      }),
      buildTurnUsageDetails({
        subagentUsage: { outputTokens: 900 },
        turnDurationMs: 5_000,
      }),
    ]);

    expect(aggregated).toMatchObject({
      outputTokens: 1_000,
      totalTokens: 1_000,
      parentUsage: expect.objectContaining({ outputTokens: 100, totalTokens: 100 }),
      subagentUsage: expect.objectContaining({ outputTokens: 900, totalTokens: 900 }),
      durationMs: 2_000,
      turnDurationMs: 5_000,
    });
  });

  it('uses the default usage currency when the same model has mixed segment currencies', () => {
    const staleCurrency = DEFAULT_USAGE_CURRENCY === 'USD' ? 'CNY' : 'USD';
    const first = buildTurnUsageDetails({
      inputTokens: 1,
      perModelCost: [{ model: 'claude-fable-5', money: gatewayMoney(4, staleCurrency) }],
    });
    const second = buildTurnUsageDetails({
      outputTokens: 1,
      perModelCost: [
        {
          model: 'claude-fable-5',
          money: gatewayMoney(6, DEFAULT_USAGE_CURRENCY),
        },
      ],
    });

    expect(aggregateTurnUsageDetails([first, second])?.perModelCost).toEqual([
      {
        model: 'claude-fable-5',
        money: gatewayMoney(6, DEFAULT_USAGE_CURRENCY),
      },
    ]);
  });

  it('ignores empty details and returns null when no segment has usage', () => {
    expect(aggregateTurnUsageDetails([null, undefined])).toBeNull();
    expect(
      aggregateTurnUsageDetails([
        {
          inputTokens: 0,
          outputTokens: 0,
          cacheReadTokens: 0,
          cacheCreateTokens: 0,
          totalTokens: 0,
          cacheHitRate: null,
        },
      ]),
    ).toBeNull();
  });

  it('keeps valid duration and drops invalid duration values', () => {
    expect(buildTurnUsageDetails({ outputTokens: 20, durationMs: 800 })).toMatchObject({
      durationMs: 800,
    });
    expect(buildTurnUsageDetails({ outputTokens: 20, durationMs: 0 })).not.toHaveProperty(
      'durationMs',
    );
    expect(
      buildTurnUsageDetails({ outputTokens: 20, durationMs: Number.NaN }),
    ).not.toHaveProperty('durationMs');
  });
});

describe('mergeTurnUsageDetailsForMessage', () => {
  it('adds input-only continuation usage without replacing prior output timing', () => {
    const generated = buildTurnUsageDetails({
      inputTokens: 100,
      outputTokens: 20,
      cacheReadTokens: 10,
      durationMs: 1_200,
      turnDurationMs: 2_000,
      model: 'claude-sonnet-4-6',
    });
    const terminal = buildTurnUsageDetails({
      inputTokens: 5,
      cacheReadTokens: 95,
      turnDurationMs: 6_500,
      model: 'claude-sonnet-4-6',
    });

    expect(mergeTurnUsageDetailsForMessage(generated, terminal!)).toMatchObject({
      inputTokens: 105,
      outputTokens: 20,
      cacheReadTokens: 105,
      totalTokens: 230,
      durationMs: 1_200,
      turnDurationMs: 6_500,
      model: 'claude-sonnet-4-6',
    });
  });

  it('preserves token facts when a tokenless terminal snapshot supplies the final wall clock', () => {
    const generated = buildTurnUsageDetails({
      inputTokens: 10,
      outputTokens: 20,
      durationMs: 1_000,
      turnDurationMs: 2_000,
    });
    const terminal = buildTurnUsageDetails({ turnDurationMs: 6_500 });

    expect(mergeTurnUsageDetailsForMessage(generated, terminal!)).toEqual({
      ...generated,
      turnDurationMs: 6_500,
    });
  });

  it('preserves an earlier final wall clock when the token snapshot arrives later', () => {
    const terminal = buildTurnUsageDetails({ turnDurationMs: 6_500 });
    const generated = buildTurnUsageDetails({
      outputTokens: 20,
      durationMs: 1_000,
      turnDurationMs: 2_000,
    });

    expect(mergeTurnUsageDetailsForMessage(terminal, generated!)).toEqual({
      ...generated,
      turnDurationMs: 6_500,
    });
  });
});
