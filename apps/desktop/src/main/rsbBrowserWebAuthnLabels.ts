/**
 * RSB WebAuthn 原生账户选择框的中英双语文案。
 *
 * 这份 catalog 不走 renderer i18next，单独成模块是为了让主进程测试能够在
 * 不加载 Electron 启动入口的前提下执行术语与标点门禁。
 */
import type { SupportedLocale } from '../shared/locale.js';

export interface RsbBrowserWebAuthnLabels {
  title: string;
  message: string;
  detail: string;
  cancel: string;
  unknownAccount: string;
  unknownRelyingParty: string;
  touchIdPromptReason: string;
}

export const RSB_BROWSER_WEBAUTHN_LABELS: Record<
  SupportedLocale,
  RsbBrowserWebAuthnLabels
> = {
  'zh-CN': {
    title: '选择通行密钥',
    message: '选择用于 {{relyingPartyId}} 的通行密钥',
    detail: 'Watchdog 只会把你的选择交给认证器；通行密钥的私密信息始终留在认证器中。',
    cancel: '取消通行密钥登录',
    unknownAccount: '通行密钥 {{index}}',
    unknownRelyingParty: '此网站',
    touchIdPromptReason: '在 $1 验证你的身份',
  },
  en: {
    title: 'Choose a Passkey',
    message: 'Choose a passkey for {{relyingPartyId}}',
    detail:
      'Watchdog only passes your selection to the authenticator; the passkey secret stays in the authenticator.',
    cancel: 'Cancel Passkey Sign-In',
    unknownAccount: 'Passkey {{index}}',
    unknownRelyingParty: 'this website',
    touchIdPromptReason: 'verify your identity on $1',
  },
};
