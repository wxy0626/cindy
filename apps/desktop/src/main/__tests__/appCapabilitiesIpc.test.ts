import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  // 2026-09-12: 跟随 AppSessionMode 放宽补上 'signed-out'(开发构建能力放宽用例需要)
  mode: 'local' as 'local' | 'cloud' | 'signed-out',
  boundaryPending: false,
  ownerStable: true,
}));

vi.mock('../appSessionState.js', () => ({
  getActiveAppSession: () => ({ mode: state.mode, dataOwnerId: 'owner-a', generation: 0 }),
  isAppSessionBoundaryPending: () => state.boundaryPending,
}));

vi.mock('../authBoundaryQuarantine.js', () => ({
  isGhostSkillProjectionBoundaryStableForOwner: () => state.ownerStable,
}));

import { requireAppCapability, deriveAppCapabilities, setDevCapabilityRelaxation } from '../appCapabilities.js';

describe('requireAppCapability IPC errors', () => {
  beforeEach(() => {
    state.mode = 'local';
    state.boundaryPending = false;
    state.ownerStable = true;
    setDevCapabilityRelaxation(null);
  });

  it('encodes unavailable account capabilities as permission errors', () => {
    expect(() => requireAppCapability('canUseSkillHubCloud')).toThrow(/\[PERMISSION_DENIED\]/);
  });

  it('encodes owner-boundary failures as retryable precondition errors', () => {
    state.mode = 'cloud';
    state.boundaryPending = true;
    expect(() => requireAppCapability('canUseDeviceLink')).toThrow(/\[PRECONDITION_FAILED\]/);
  });

  it('keeps normal cloud capabilities available when only the Ghost projection owner differs', () => {
    state.mode = 'cloud';
    state.ownerStable = false;
    expect(() => requireAppCapability('canUseCindyAccountServices')).not.toThrow();
    expect(() => requireAppCapability('canUseCindyGateway')).not.toThrow();
    expect(() => requireAppCapability('canUseDeviceLink')).not.toThrow();
    expect(() => requireAppCapability('canUseSkillHubCloud')).not.toThrow();
    expect(() => requireAppCapability('canUseCindyOAuthBroker')).not.toThrow();
    expect(() => requireAppCapability('canUseCindyHeartbeat')).not.toThrow();
  });
});

/**
 * 开发构建放宽(2026-09-12 用户要求:dev 实例未登录也能像正式登录一样用任意模型)。
 *
 * 关键约束:放宽只作用于**未打包**构建,且不改变 boundaryPending(切换期仍需重试)语义。
 * 这里的开关是注入式(装配层接 `!app.isPackaged`),所以可以精确断言两侧行为。
 */
describe('开发构建能力放宽', () => {
  beforeEach(() => {
    state.mode = 'signed-out';
    state.boundaryPending = false;
    state.ownerStable = true;
    setDevCapabilityRelaxation(null);
  });

  it('默认(打包版)未登录时账号能力全为 false', () => {
    const caps = deriveAppCapabilities('signed-out');
    expect(caps.canUseCindyGateway).toBe(false);
    expect(caps.canUseCindyAccountServices).toBe(false);
    expect(() => requireAppCapability('canUseCindyGateway')).toThrow(/\[PERMISSION_DENIED\]/);
  });

  it('放宽开启后未登录也拿到账号能力(dev 实例与正式登录一致)', () => {
    setDevCapabilityRelaxation(true);
    const caps = deriveAppCapabilities('signed-out');
    expect(caps.canUseCindyGateway).toBe(true);
    expect(caps.canUseDeviceLink).toBe(true);
    expect(() => requireAppCapability('canUseCindyGateway')).not.toThrow();
  });

  it('放宽不越过 boundaryPending:切换期仍报可重试前置错误', () => {
    setDevCapabilityRelaxation(true);
    state.boundaryPending = true;
    expect(() => requireAppCapability('canUseCindyGateway')).toThrow(/\[PRECONDITION_FAILED\]/);
  });

  it('复位后回到默认严格口径', () => {
    setDevCapabilityRelaxation(true);
    expect(deriveAppCapabilities('signed-out').canUseCindyGateway).toBe(true);
    setDevCapabilityRelaxation(null);
    expect(deriveAppCapabilities('signed-out').canUseCindyGateway).toBe(false);
  });
});
