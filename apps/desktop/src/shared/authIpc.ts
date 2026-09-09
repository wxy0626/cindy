/** Typed renderer/main boundary for the auth-server login and account lifecycle flows. */
import type {
  AccountDeletionAvailability,
  AccountDeletionStatus,
  AuthFlowState,
  VerificationKind,
} from '@cindy/auth-client';
import type { LocalProjectSyncOptions } from './localProjectSync.js';
import { parseLocalProjectSyncOptions } from './localProjectSync.js';

export type DesktopLoginAction =
  | { type: 'reset' }
  | { type: 'cancel-browser' }
  | { type: 'discover'; email: string; localProjectSync?: LocalProjectSyncOptions }
  | { type: 'discover-sso-org'; org: string }
  | { type: 'confirm-sso-realm' }
  | { type: 'cancel-sso-realm' }
  | {
      type: 'request-code';
      kind: VerificationKind;
      identifier: string;
      captchaToken?: string;
      localProjectSync?: LocalProjectSyncOptions;
    }
  | {
      type: 'verify-code';
      kind: VerificationKind;
      identifier: string;
      code: string;
      localProjectSync?: LocalProjectSyncOptions;
    }
  | {
      type: 'start-browser';
      kind: 'social' | 'sso';
      providerOrConnectionId: string;
      label: string;
      localProjectSync?: LocalProjectSyncOptions;
    }
  | { type: 'select-account'; accountId: string; localProjectSync?: LocalProjectSyncOptions }
  | { type: 'request-sso-verification-code' }
  | { type: 'verify-sso-verification'; code: string }
  | { type: 'request-binding-code'; contact: string }
  | { type: 'verify-binding'; contact: string; code: string };

export type DesktopLoginActionResult =
  | { success: true; state: AuthFlowState }
  | { success: false; code: string; state: AuthFlowState | null };

export interface DesktopSavedAccount {
  /** Opaque main-owned identifier. Renderer must not derive realm or membership ids from it. */
  accountKey: string;
  displayName: string;
  email: string | null;
  avatarUrl: string | null;
  kind: 'personal' | 'org';
  orgName: string | null;
  orgLogoUrl: string | null;
  isCurrent: boolean;
}

export interface DesktopAccountSwitcherSnapshot {
  accounts: DesktopSavedAccount[];
  mutationAllowed: boolean;
}

/** 已保存账号快捷切换请求；同步策略仍由主进程边界严格解析。 */
export interface DesktopAccountSwitchRequest {
  accountKey: string;
  localProjectSync?: LocalProjectSyncOptions;
}

/** The receipt token stays in Electron main; renderer only receives display-safe fields. */
export interface DesktopAccountDeletionChallenge {
  challengeId: string;
  channel: 'email' | 'sms';
  maskedTarget: string;
  expiresAt: string;
}

export interface DesktopAccountDeletionConfirmInput {
  challengeId: string;
  code: string;
}

/** Account-deletion IPC keeps auth-server error codes as structured UI metadata. */
export type DesktopAccountDeletionResult<T> =
  { success: true; value: T } | { success: false; code: string };

export type DesktopAccountDeletionAvailabilityResult =
  DesktopAccountDeletionResult<AccountDeletionAvailability>;
export type DesktopAccountDeletionChallengeResult =
  DesktopAccountDeletionResult<DesktopAccountDeletionChallenge>;
export type DesktopAccountDeletionConfirmResult =
  DesktopAccountDeletionResult<AccountDeletionStatus>;
export type DesktopAccountDeletionStatusResult =
  DesktopAccountDeletionResult<AccountDeletionStatus | null>;

const MAX_IDENTIFIER_LENGTH = 320;
const MAX_OPAQUE_ID_LENGTH = 256;
const MAX_CODE_LENGTH = 32;
// Turnstile token 官方上限 2048 字符(服务端 schema 同值)。
const MAX_CAPTCHA_TOKEN_LENGTH = 2048;
// 与 auth-server 的企业 ID / slug / 已验证域名统一上限对齐。
const MAX_ORG_IDENTIFIER_LENGTH = 253;
const MAX_ACCOUNT_KEY_LENGTH = 512;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isBoundedString(value: unknown, maxLength: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= maxLength;
}

/** 共享策略字段出现但不合法时拒绝整条 action，避免静默降级为未共享。 */
function parseOptionalLocalProjectSync(
  value: unknown,
): LocalProjectSyncOptions | undefined | null {
  if (value === undefined) return undefined;
  return parseLocalProjectSyncOptions(value);
}

function isVerificationKind(value: unknown): value is VerificationKind {
  return value === 'email' || value === 'phone';
}

/**
 * Runtime validation for the untrusted renderer-to-main IPC boundary. The
 * returned object only contains fields recognized by the selected action.
 */
export function parseDesktopLoginAction(value: unknown): DesktopLoginAction | null {
  if (!isRecord(value) || typeof value.type !== 'string') return null;

  switch (value.type) {
    case 'reset':
      return { type: 'reset' };
    case 'cancel-browser':
      return { type: 'cancel-browser' };
    case 'discover': {
      const localProjectSync = parseOptionalLocalProjectSync(value.localProjectSync);
      return isBoundedString(value.email, MAX_IDENTIFIER_LENGTH) && localProjectSync !== null
        ? { type: 'discover', email: value.email, ...(localProjectSync ? { localProjectSync } : {}) }
        : null;
    }
    case 'discover-sso-org':
      return isBoundedString(value.org, MAX_ORG_IDENTIFIER_LENGTH)
        ? { type: 'discover-sso-org', org: value.org }
        : null;
    case 'confirm-sso-realm':
      return { type: 'confirm-sso-realm' };
    case 'cancel-sso-realm':
      return { type: 'cancel-sso-realm' };
    case 'request-code': {
      if (
        !isVerificationKind(value.kind) ||
        !isBoundedString(value.identifier, MAX_IDENTIFIER_LENGTH)
      ) {
        return null;
      }
      // captchaToken 缺省合法(cn 构建 / captcha 未启用);一旦携带必须过界校验,
      // 非法则整条 action 拒绝,不做静默剥离。
      const localProjectSync = parseOptionalLocalProjectSync(value.localProjectSync);
      if (localProjectSync === null) return null;
      if (value.captchaToken === undefined) {
        return { type: 'request-code', kind: value.kind, identifier: value.identifier, ...(localProjectSync ? { localProjectSync } : {}) };
      }
      return isBoundedString(value.captchaToken, MAX_CAPTCHA_TOKEN_LENGTH)
        ? {
            type: 'request-code',
            kind: value.kind,
            identifier: value.identifier,
            captchaToken: value.captchaToken,
            ...(localProjectSync
              ? { localProjectSync }
              : {}),
          }
        : null;
    }
    case 'verify-code':
      {
        const localProjectSync = parseOptionalLocalProjectSync(value.localProjectSync);
        return isVerificationKind(value.kind) &&
          isBoundedString(value.identifier, MAX_IDENTIFIER_LENGTH) &&
          isBoundedString(value.code, MAX_CODE_LENGTH) &&
          localProjectSync !== null
          ? {
              type: 'verify-code',
              kind: value.kind,
              identifier: value.identifier,
              code: value.code,
              ...(localProjectSync ? { localProjectSync } : {}),
            }
          : null;
      }
    case 'start-browser':
      {
        const localProjectSync =
          value.kind === 'social'
            ? parseOptionalLocalProjectSync(value.localProjectSync)
            : undefined;
        return (value.kind === 'social' || value.kind === 'sso') &&
          isBoundedString(value.providerOrConnectionId, MAX_OPAQUE_ID_LENGTH) &&
          isBoundedString(value.label, MAX_OPAQUE_ID_LENGTH) &&
          localProjectSync !== null
          ? {
              type: 'start-browser',
              kind: value.kind,
              providerOrConnectionId: value.providerOrConnectionId,
              label: value.label,
              ...(localProjectSync ? { localProjectSync } : {}),
            }
          : null;
      }
    case 'select-account':
      {
        const localProjectSync = parseOptionalLocalProjectSync(value.localProjectSync);
        return isBoundedString(value.accountId, MAX_OPAQUE_ID_LENGTH) && localProjectSync !== null
          ? { type: 'select-account', accountId: value.accountId, ...(localProjectSync ? { localProjectSync } : {}) }
          : null;
      }
    case 'request-sso-verification-code':
      return { type: 'request-sso-verification-code' };
    case 'verify-sso-verification':
      return isBoundedString(value.code, MAX_CODE_LENGTH)
        ? { type: 'verify-sso-verification', code: value.code }
        : null;
    case 'request-binding-code':
      return isBoundedString(value.contact, MAX_IDENTIFIER_LENGTH)
        ? { type: 'request-binding-code', contact: value.contact }
        : null;
    case 'verify-binding':
      return isBoundedString(value.contact, MAX_IDENTIFIER_LENGTH) &&
        isBoundedString(value.code, MAX_CODE_LENGTH)
        ? { type: 'verify-binding', contact: value.contact, code: value.code }
        : null;
    default:
      return null;
  }
}

export function parseDesktopAccountKey(value: unknown): string | null {
  return isBoundedString(value, MAX_ACCOUNT_KEY_LENGTH) ? value : null;
}

/**
 * 解析已保存账号切换请求。
 * 旧版本只传字符串账号 key，因此字符串形式必须继续支持；对象形式用于
 * 传递登录页同源的本地项目同步白名单，并且只保留受认可的字段。
 */
export function parseDesktopAccountSwitchRequest(
  value: unknown,
): DesktopAccountSwitchRequest | null {
  const record =
    typeof value === 'string'
      ? { accountKey: value }
      : isRecord(value)
        ? value
        : null;
  if (!record) return null;

  const accountKey = parseDesktopAccountKey(record.accountKey);
  const localProjectSync = parseOptionalLocalProjectSync(record.localProjectSync);
  if (!accountKey || localProjectSync === null) return null;
  return {
    accountKey,
    ...(localProjectSync ? { localProjectSync } : {}),
  };
}

/** Runtime validation for the irreversible account-deletion confirmation boundary. */
export function parseDesktopAccountDeletionConfirmInput(
  value: unknown,
): DesktopAccountDeletionConfirmInput | null {
  if (!isRecord(value)) return null;
  if (!isBoundedString(value.challengeId, MAX_OPAQUE_ID_LENGTH)) return null;
  if (typeof value.code !== 'string' || !/^\d{6}$/.test(value.code)) return null;
  return { challengeId: value.challengeId, code: value.code };
}
