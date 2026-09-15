/**
 * Central capability boundary for services owned by the Cindy account plane.
 *
 * Public CDN/endpoint manifests, updates and anonymous TapDB deliberately do
 * not use this gate. Account services must check it at their main-process
 * boundary even when the renderer also hides their entry point.
 */
import {
  getActiveAppSession,
  isAppSessionBoundaryPending,
  type AppSessionMode,
} from './appSessionState.js';
import { throwIpcError } from './utils/ipcValidate.js';

export interface AppCapabilities {
  canUseCindyAccountServices: boolean;
  canUseCindyGateway: boolean;
  canUseDeviceLink: boolean;
  canUseSkillHubCloud: boolean;
  canUseCindyOAuthBroker: boolean;
  canUseCindyHeartbeat: boolean;
}

/**
 * 开发构建的能力放宽开关(默认关)。
 *
 * 为什么不直接 `import { app } from 'electron'`:本模块被单测直接 import,构造期读
 * electron 会把 Electron 运行时依赖提前到 import 期,单测无法加载(appCapabilitiesIpc.test.ts)。
 * 沿用 authManager 的 `createAuthLoopbackDevBridgeSlot(() => app.isPackaged)` 同款注入法:
 * 装配层(bootstrap)在 splash 前把真实 `!app.isPackaged` 接进来,单测天然拿到 false。
 *
 * 语义:仅**未打包**的开发构建放宽 —— dev 实例里没登录也能像正式登录一样选任意模型,
 * 打包后的正式版行为完全不变(不会把放宽泄漏给终端用户)。
 */
let devCapabilityRelaxationEnabled = false;

/** 装配层注入:传 `!app.isPackaged` 即启用开发放宽。传 null 复位(测试隔离)。 */
export function setDevCapabilityRelaxation(enabled: boolean | null): void {
  devCapabilityRelaxationEnabled = enabled === true;
}

export function deriveAppCapabilities(
  mode: AppSessionMode,
  boundaryPending = false,
): AppCapabilities {
  // 开发放宽:未打包构建里把「账号能力」视为可用,让 dev 实例与正式登录一致。
  // 边界仍以后者为准 —— 放宽不改变 boundaryPending 的语义(切换期仍需重试)。
  const cloud = (mode === 'cloud' || devCapabilityRelaxationEnabled) && !boundaryPending;
  return {
    canUseCindyAccountServices: cloud,
    canUseCindyGateway: cloud,
    canUseDeviceLink: cloud,
    canUseSkillHubCloud: cloud,
    canUseCindyOAuthBroker: cloud,
    canUseCindyHeartbeat: cloud,
  };
}

export function getAppCapabilities(): AppCapabilities {
  const session = getActiveAppSession();
  return deriveAppCapabilities(session.mode, isAppSessionBoundaryPending());
}

export function requireAppCapability(
  capability: keyof AppCapabilities,
  message = 'This feature requires a Cindy account.',
): void {
  const session = getActiveAppSession();
  const boundaryPending = isAppSessionBoundaryPending();
  if (deriveAppCapabilities(session.mode, boundaryPending)[capability]) return;
  if (boundaryPending) {
    throwIpcError(
      'PRECONDITION_FAILED',
      'App session is switching; retry after the owner boundary settles.',
    );
  }
  throwIpcError('PERMISSION_DENIED', message);
}
