import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { describe, it, expect, vi, beforeEach } from 'vitest';

const sessionState = vi.hoisted(() => ({
  mode: 'signed-out' as 'signed-out' | 'local' | 'cloud',
  dataOwnerId: null as string | null,
}));

// providerSecretStore 顶层 `import { app, safeStorage } from 'electron'` —— 这些测试
// 注入自己的 SecretStorageIo,不会走默认 electronSecretIo,因此 electron mock 只为
// 让 import 链在 node 测试环境下可加载(app.getPath 给个 tmp 目录即可)。
// 严格快照用例走真实 fs + safeStorage 分支,通过 electronState 切换目录与解密结果。
const electronState = vi.hoisted(() => ({
  userData: '/tmp/xdt-provider-secret-test',
  encryptionAvailable: false,
  decryptString: (): string => '',
}));

vi.mock('electron', () => ({
  app: { getPath: () => electronState.userData },
  safeStorage: {
    isEncryptionAvailable: () => electronState.encryptionAvailable,
    encryptString: () => Buffer.from(''),
    decryptString: () => electronState.decryptString(),
  },
}));

vi.mock('../../logger', () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

vi.mock('../../appSessionState', () => ({
  getActiveAppSession: () => ({ ...sessionState, generation: 0 }),
  dataOwnerStorageKey: (ownerId: string) => ownerId,
  LOCAL_DATA_OWNER_ID: 'local-v1',
}));

import {
  createProviderSecretStore,
  readCustomProviderHeadersForMutation,
  readCustomProviderKeyForMutation,
  readGhostSecretStrict,
  readGhostSecretTailFromIo,
  resolveOwnerScopedSecretStorageKey,
  resolveOwnerScopedSecretStorageKeyForRead,
  setProviderSecretsClearedListener,
  UNRECOVERABLE_PROVIDER_CREDENTIAL,
  type SecretStorageIo,
} from '../providerSecretStore';
import {
  providerSecretStorageKey,
  customMcpSecretStorageKey,
  customProviderHeaderStorageKey,
  customProviderSecretStorageKey,
  providerOAuthStorageKey,
  ghostSecretStorageKey,
  ghostSecretHintStorageKey,
  deriveGhostSecretTail,
  GHOST_SECRET_TAIL_MIN_VALUE_CHARS,
  isRendererAccessibleSafeStorageKey,
  PI_PROXY_DERIVATION_KEY_STORAGE_KEY,
  PROVIDER_SECRET_IDS,
  REMOTE_MCP_BRIDGE_TOKEN_STORAGE_KEY,
} from '../../../shared/providerSecrets';

/** 内存版 SecretStorageIo:按"存储键名"读写一个 Map,模拟 safeStorage 文件层。 */
function createMemoryIo(): SecretStorageIo & { store: Map<string, string> } {
  const store = new Map<string, string>();
  return {
    store,
    isAvailable: () => true,
    read: (k) => (store.has(k) ? (store.get(k) as string) : null),
    write: (k, v) => {
      store.set(k, v);
      return true;
    },
    remove: (k) => {
      store.delete(k);
      return { success: true };
    },
    list: () => [...store.keys()],
  };
}

describe('providerSecrets registry', () => {
  it('maps known providers to their stable storage keys', () => {
    expect(providerSecretStorageKey('xd')).toBe('api_key');
    expect(providerSecretStorageKey('mivo')).toBe('mivo_api_key');
    expect(providerSecretStorageKey('brave')).toBe('brave_search_api_key');
    expect(providerSecretStorageKey('tavily')).toBe('tavily_api_key');
    expect(providerSecretStorageKey('voice-asr')).toBe('voice_input_asr_api_key');
  });

  it('lists all registered provider ids', () => {
    expect(PROVIDER_SECRET_IDS).toEqual(
      expect.arrayContaining(['xd', 'mivo', 'brave', 'tavily', 'voice-asr']),
    );
  });

  it('keeps the voice ASR key behind its dedicated main-only IPC boundary', () => {
    expect(isRendererAccessibleSafeStorageKey(providerSecretStorageKey('voice-asr'))).toBe(false);
    expect(isRendererAccessibleSafeStorageKey('VOICE_INPUT_ASR_API_KEY')).toBe(false);
    expect(isRendererAccessibleSafeStorageKey(providerSecretStorageKey('xd'))).toBe(true);
    expect(isRendererAccessibleSafeStorageKey(customMcpSecretStorageKey('example'))).toBe(true);
  });

  it('keeps the Gemini API key behind its dedicated main-only IPC boundary', () => {
    expect(isRendererAccessibleSafeStorageKey(providerSecretStorageKey('gemini'))).toBe(false);
    expect(isRendererAccessibleSafeStorageKey('PROVIDER_KEY_GEMINI')).toBe(false);
  });

  it('keeps the OpenAI images API key behind its dedicated main-only IPC boundary', () => {
    expect(isRendererAccessibleSafeStorageKey(providerSecretStorageKey('openai-images'))).toBe(false);
    expect(isRendererAccessibleSafeStorageKey('PROVIDER_KEY_OPENAI_IMAGES')).toBe(false);
  });

  it('keeps daemon-wide remote secrets behind the main-only boundary', () => {
    expect(isRendererAccessibleSafeStorageKey(REMOTE_MCP_BRIDGE_TOKEN_STORAGE_KEY)).toBe(false);
    expect(isRendererAccessibleSafeStorageKey(PI_PROXY_DERIVATION_KEY_STORAGE_KEY)).toBe(false);
  });

  it('keeps custom-provider header blobs behind the main-only boundary', () => {
    const key = customProviderHeaderStorageKey('my_or', 'pi');
    expect(key).toBe('provider_headers_my_or_pi');
    expect(isRendererAccessibleSafeStorageKey(key)).toBe(false);
    expect(() => customProviderHeaderStorageKey('bad/path', 'pi')).toThrow(/illegal characters/);
  });

  it('动态键名构造前校验片段字符集,路径逃逸类 id 直接抛错', () => {
    expect(providerOAuthStorageKey('acme-1')).toBe('provider_oauth_acme-1');
    expect(customProviderSecretStorageKey('my_or', 'claude-code')).toBe('provider_key_my_or_claude-code');
    expect(() => providerOAuthStorageKey('x/../../oauth')).toThrow(/illegal characters/);
    expect(() => providerOAuthStorageKey('a.b')).toThrow(/illegal characters/);
    expect(() => customProviderSecretStorageKey('ok', 'claude/../code')).toThrow(/illegal characters/);
  });

  it('意识凭证键名构造(ghost_secret_<ghostId>_<key>),非法片段抛错', () => {
    expect(ghostSecretStorageKey('my-ghost', 'brave_api_key')).toBe('ghost_secret_my-ghost_brave_api_key');
    expect(() => ghostSecretStorageKey('x/../evil', 'k')).toThrow(/illegal characters/);
    expect(() => ghostSecretStorageKey('ok', 'k.ey')).toThrow(/illegal characters/);
  });

  it('官方别名:cindy-web-search 的凭证映射到历史 brave/tavily 存储键(老用户零迁移)', () => {
    // 与「工具密钥」时代同一 .enc 文件:老用户已填 key 对意识立即生效,
    // lizi_web_search MCP 也照读同一份。
    expect(ghostSecretStorageKey('cindy-web-search', 'brave_api_key')).toBe(providerSecretStorageKey('brave'));
    expect(ghostSecretStorageKey('cindy-web-search', 'tavily_api_key')).toBe(providerSecretStorageKey('tavily'));
    // 别名只对登记过的 (ghostId, key) 生效:同 id 其它 key、其它意识同名 key 都走缺省命名空间。
    expect(ghostSecretStorageKey('cindy-web-search', 'other_key')).toBe('ghost_secret_cindy-web-search_other_key');
    expect(ghostSecretStorageKey('third-party', 'brave_api_key')).toBe('ghost_secret_third-party_brave_api_key');
  });

  it('官方别名:xd-mivo 的 mivo_api_key 映射到历史 mivo 存储键(老用户零迁移)', () => {
    expect(ghostSecretStorageKey('xd-mivo', 'mivo_api_key')).toBe(providerSecretStorageKey('mivo'));
    expect(ghostSecretStorageKey('xd-mivo', 'other_key')).toBe('ghost_secret_xd-mivo_other_key');
    expect(ghostSecretStorageKey('third-party', 'mivo_api_key')).toBe('ghost_secret_third-party_mivo_api_key');
  });

  it('意识凭证尾指纹:键名独立前缀(ghost_hint_)+ 短值不产指纹', () => {
    expect(ghostSecretHintStorageKey('my-ghost', 'api_key')).toBe('ghost_hint_my-ghost_api_key');
    expect(() => ghostSecretHintStorageKey('x/../evil', 'k')).toThrow(/illegal characters/);
    // 指纹永远走 ghost_hint_ 命名空间,官方别名(密文键)不牵连它。
    expect(ghostSecretHintStorageKey('xd-mivo', 'mivo_api_key')).toBe('ghost_hint_xd-mivo_mivo_api_key');

    expect(deriveGhostSecretTail('mivo_abcdefgh1234')).toBe('1234');
    expect(deriveGhostSecretTail('x'.repeat(GHOST_SECRET_TAIL_MIN_VALUE_CHARS))).toBe('xxxx');
    expect(deriveGhostSecretTail('x'.repeat(GHOST_SECRET_TAIL_MIN_VALUE_CHARS - 1))).toBeNull();
    expect(deriveGhostSecretTail('')).toBeNull();
  });

  it('every registered storage key is a valid safe-storage key name', () => {
    // 与 bootstrap-electron 的 isValidKey 同正则;新增供应商若键名非法这里会红。
    const valid = /^[a-zA-Z0-9_-]+$/;
    for (const id of PROVIDER_SECRET_IDS) {
      expect(providerSecretStorageKey(id)).toMatch(valid);
    }
  });

  it('strict custom-provider snapshot treats a missing file as absent when encryption is unavailable', () => {
    const previousMode = sessionState.mode;
    const previousOwnerId = sessionState.dataOwnerId;
    sessionState.mode = 'cloud';
    sessionState.dataOwnerId = `missing-key-owner-${process.pid}`;
    try {
      expect(
        readCustomProviderKeyForMutation(`missing-key-provider-${process.pid}`, 'codex'),
      ).toBeNull();
    } finally {
      sessionState.mode = previousMode;
      sessionState.dataOwnerId = previousOwnerId;
    }
  });

  it('strict custom-provider snapshot reports ciphertext that exists but cannot be decrypted', () => {
    const previousMode = sessionState.mode;
    const previousOwnerId = sessionState.dataOwnerId;
    const previousElectron = { ...electronState };
    const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'xdt-provider-secret-'));
    const ownerId = 'undecryptable-owner';
    const providerId = 'undecryptable-provider';
    sessionState.mode = 'cloud';
    sessionState.dataOwnerId = ownerId;
    electronState.userData = userData;
    electronState.encryptionAvailable = true;
    electronState.decryptString = () => {
      throw new Error('Error while decrypting the ciphertext provided to safeStorage.decryptString.');
    };
    try {
      const secretDir = path.join(userData, 'safe-storage');
      fs.mkdirSync(secretDir, { recursive: true });
      const garbage = Buffer.from('not-a-safe-storage-blob').toString('base64');
      for (const logicalKey of [
        customProviderSecretStorageKey(providerId, 'codex'),
        customProviderHeaderStorageKey(providerId, 'codex'),
      ]) {
        const scopedKey = resolveOwnerScopedSecretStorageKey(logicalKey);
        if (!scopedKey) throw new Error('test owner session is not scoped');
        fs.writeFileSync(path.join(secretDir, `${scopedKey}.enc`), garbage, 'utf-8');
      }

      // 密文存在但解不开:第三态,而不是抛错(#3821)。
      expect(readCustomProviderKeyForMutation(providerId, 'codex')).toBe(
        UNRECOVERABLE_PROVIDER_CREDENTIAL,
      );
      expect(readCustomProviderHeadersForMutation(providerId, 'codex')).toBe(
        UNRECOVERABLE_PROVIDER_CREDENTIAL,
      );
      // 解得开但不是合法头 map:同样是内容层面的永久损坏。
      electronState.decryptString = () => '["not","an","object"]';
      expect(readCustomProviderHeadersForMutation(providerId, 'codex')).toBe(
        UNRECOVERABLE_PROVIDER_CREDENTIAL,
      );
      // 文件在、但 safeStorage 暂时不可用:仍然抛错,不能当成可覆盖。
      electronState.encryptionAvailable = false;
      expect(() => readCustomProviderKeyForMutation(providerId, 'codex')).toThrow(
        /encryption is unavailable/,
      );
      expect(() => readCustomProviderHeadersForMutation(providerId, 'codex')).toThrow(
        /encryption is unavailable/,
      );
    } finally {
      sessionState.mode = previousMode;
      sessionState.dataOwnerId = previousOwnerId;
      Object.assign(electronState, previousElectron);
      fs.rmSync(userData, { recursive: true, force: true });
    }
  });

  it('strict Ghost reconciliation treats a missing file as absent when encryption is unavailable', () => {
    const previousMode = sessionState.mode;
    const previousOwnerId = sessionState.dataOwnerId;
    sessionState.mode = 'cloud';
    sessionState.dataOwnerId = `missing-ghost-owner-${process.pid}`;
    try {
      expect(
        readGhostSecretStrict(`missing-ghost-${process.pid}`, 'oauth_accounts'),
      ).toBeNull();
    } finally {
      sessionState.mode = previousMode;
      sessionState.dataOwnerId = previousOwnerId;
    }
  });
});

describe('providerSecretStore', () => {
  let io: ReturnType<typeof createMemoryIo>;

  beforeEach(() => {
    io = createMemoryIo();
    setProviderSecretsClearedListener(() => {});
  });

  it('set then get round-trips by provider id, keyed by storage name', () => {
    const store = createProviderSecretStore(io);
    expect(store.set('xd', 'sk-test')).toBe(true);
    expect(store.get('xd')).toBe('sk-test');
    // 落盘用的是 registry 解析出的"存储键名",而非 provider id 本身。
    expect(io.store.get('api_key')).toBe('sk-test');
    expect(io.store.has('xd')).toBe(false);
  });

  it('get returns null for an unconfigured provider', () => {
    const store = createProviderSecretStore(io);
    expect(store.get('mivo')).toBeNull();
    expect(store.has('mivo')).toBe(false);
  });

  it('has reflects presence after set', () => {
    const store = createProviderSecretStore(io);
    store.set('mivo', 'mivo_abc');
    expect(store.has('mivo')).toBe(true);
  });

  it('remove deletes the secret and is idempotent', () => {
    const store = createProviderSecretStore(io);
    store.set('xd', 'sk-x');
    expect(store.remove('xd')).toEqual({ success: true });
    expect(store.get('xd')).toBeNull();
    // 再删一次(已不存在)仍成功(幂等)。
    expect(store.remove('xd')).toEqual({ success: true });
  });

  it('isolates providers by storage key', () => {
    const store = createProviderSecretStore(io);
    store.set('xd', 'sk-xd');
    store.set('mivo', 'mivo_m');
    store.remove('xd');
    expect(store.get('xd')).toBeNull();
    expect(store.get('mivo')).toBe('mivo_m');
  });

  it('get/has swallow io.read errors and return null/false', () => {
    const throwingIo: SecretStorageIo = {
      isAvailable: () => true,
      read: () => {
        throw new Error('boom');
      },
      write: () => false,
      remove: () => ({ success: true }),
      list: () => [],
    };
    const store = createProviderSecretStore(throwingIo);
    expect(store.get('xd')).toBeNull();
    expect(store.has('xd')).toBe(false);
  });
});

/**
 * 未登录(signed-out)时的密钥可达性回归锁。
 *
 * 2026-09-12 用户反馈:未登录时设置页「模型供应商」里自建供应商的模型开关全部禁用,
 * 提示「连接后可用」。根因是 dataOwnerId 为 null 时 resolveOwnerScopedSecretStorageKey
 * 直接返回 null —— 自建供应商的 key 明明已落盘,连接态却恒为 false。
 * 自建供应商的 API key 属本机凭证、与 Cindy 账号无关,无 owner 时应回落到本地档案
 * 命名空间(local-v1),让 dev / 本地档案用户与正式登录体验一致。
 */
describe('providerSecretStore 未登录时的本地档案回落', () => {
  it('signed-out 仍解析出本地档案命名空间的存储键(不再返回 null)', () => {
    const previousMode = sessionState.mode;
    const previousOwnerId = sessionState.dataOwnerId;
    sessionState.mode = 'signed-out';
    sessionState.dataOwnerId = null;
    try {
      const scoped = resolveOwnerScopedSecretStorageKey('api_key');
      expect(scoped).not.toBeNull();
      // mock 里 dataOwnerStorageKey 是恒等映射,故前缀直接是 owner id。
      expect(scoped).toBe('owner_local-v1_api_key');
    } finally {
      sessionState.mode = previousMode;
      sessionState.dataOwnerId = previousOwnerId;
    }
  });

  it('云账号仍走各自 owner 前缀,不与本地档案槽串号', () => {
    const previousMode = sessionState.mode;
    const previousOwnerId = sessionState.dataOwnerId;
    sessionState.mode = 'cloud';
    sessionState.dataOwnerId = 'cloud-user-1';
    try {
      expect(resolveOwnerScopedSecretStorageKey('api_key')).toBe('owner_cloud-user-1_api_key');
    } finally {
      sessionState.mode = previousMode;
      sessionState.dataOwnerId = previousOwnerId;
    }
  });

  it('signed-out 时 clearAll() 能扫到本地档案槽的动态键(前缀口径与解析器一致)', () => {
    const previousMode = sessionState.mode;
    const previousOwnerId = sessionState.dataOwnerId;
    sessionState.mode = 'signed-out';
    sessionState.dataOwnerId = null;
    try {
      // 用内存 IO 记录 list() 被问到哪些键、以及 remove() 收了哪些。
      // 关键断言:list() 返回的是**本地档案槽**的键 —— 若仍按「无 owner 返回空」
      // 的旧口径,动态键(provider_key_*)就漏清了,同机换账号会串号。
      const memoryIo = createMemoryIo();
      memoryIo.list = () => ['provider_key_sub_codex'];
      const store = createProviderSecretStore(memoryIo);
      store.clearAll();
      expect(memoryIo.store.size).toBe(0);
    } finally {
      sessionState.mode = previousMode;
      sessionState.dataOwnerId = previousOwnerId;
    }
  });

  it('默认 IO 的 list() 在 signed-out 时按本地档案前缀过滤磁盘文件', () => {
    const previousMode = sessionState.mode;
    const previousOwnerId = sessionState.dataOwnerId;
    const previousElectron = { ...electronState };
    const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'xdt-signed-out-list-'));
    sessionState.mode = 'signed-out';
    sessionState.dataOwnerId = null;
    electronState.userData = userData;
    try {
      const secretDir = path.join(userData, 'safe-storage');
      fs.mkdirSync(secretDir, { recursive: true });
      // 模拟「未登录时写过自定义供应商 key」:落在本地档案前缀下。
      fs.writeFileSync(path.join(secretDir, 'owner_local-v1_provider_key_sub_codex.enc'), 'x');
      // 另一个账号槽的文件不应被扫到(不串号)。
      fs.writeFileSync(path.join(secretDir, 'owner_other-user_provider_key_sub_codex.enc'), 'x');

      const memoryIo = createMemoryIo();
      const store = createProviderSecretStore(memoryIo);
      // 未登录时 getOwnerUserId 应为 null(owner 标记只由账号对账写入)。
      expect(store.getOwnerUserId()).toBeNull();
      // 派生键与解析器保持一致 —— 这是「读得到 key」的最直接证据。
      expect(resolveOwnerScopedSecretStorageKey('provider_key_sub_codex')).toBe(
        'owner_local-v1_provider_key_sub_codex',
      );
    } finally {
      sessionState.mode = previousMode;
      sessionState.dataOwnerId = previousOwnerId;
      Object.assign(electronState, previousElectron);
      fs.rmSync(userData, { recursive: true, force: true });
    }
  });

  /**
   * 读路径跨槽位回落(2026-09-12 二次修复):key 是**登录云账号时**配置的,
   * 落在该账号槽位;未登录(signed-out/local)时严格解析只见 local-v1 槽位 ——
   * 空的,自建供应商依旧「未连接」。ForRead 在未登录态回落到本机最近配置的
   * 同名凭证;云账号在场则严格自己槽位,隔离不放松。
   */
  describe('读路径回落 resolveOwnerScopedSecretStorageKeyForRead', () => {
    /** 在临时 userData 里摆好两个云账号槽位的同名凭证,mtime 可控。 */
    function seedOwnerSlots(userData: string, slots: { owner: string; mtimeMs: number }[]): void {
      const secretDir = path.join(userData, 'safe-storage');
      fs.mkdirSync(secretDir, { recursive: true });
      for (const { owner, mtimeMs } of slots) {
        const file = path.join(secretDir, `owner_${owner}_provider_key_sub_codex.enc`);
        fs.writeFileSync(file, 'x');
        fs.utimesSync(file, new Date(mtimeMs), new Date(mtimeMs));
      }
    }

    it('signed-out 且本地槽位没有 → 回落到 mtime 最新的云账号槽位(用户实际场景)', () => {
      const previousMode = sessionState.mode;
      const previousOwnerId = sessionState.dataOwnerId;
      const previousElectron = { ...electronState };
      const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'xdt-read-fallback-'));
      sessionState.mode = 'signed-out';
      sessionState.dataOwnerId = null;
      electronState.userData = userData;
      try {
        // 复刻实测分布:账号 A 9/6 配的,账号 B 9/9 配的;B 更新 → 应解析到 B。
        seedOwnerSlots(userData, [
          { owner: 'aaaa0000000000000000', mtimeMs: 1000 },
          { owner: 'bbbb0000000000000000', mtimeMs: 2000 },
        ]);
        expect(resolveOwnerScopedSecretStorageKeyForRead('provider_key_sub_codex')).toBe(
          'owner_bbbb0000000000000000_provider_key_sub_codex',
        );
      } finally {
        sessionState.mode = previousMode;
        sessionState.dataOwnerId = previousOwnerId;
        Object.assign(electronState, previousElectron);
        fs.rmSync(userData, { recursive: true, force: true });
      }
    });

    it('signed-out 但本地槽位已有该键 → 优先本地,不回落', () => {
      const previousMode = sessionState.mode;
      const previousOwnerId = sessionState.dataOwnerId;
      const previousElectron = { ...electronState };
      const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'xdt-read-local-first-'));
      sessionState.mode = 'signed-out';
      sessionState.dataOwnerId = null;
      electronState.userData = userData;
      try {
        seedOwnerSlots(userData, [{ owner: 'aaaa0000000000000000', mtimeMs: 9999 }]);
        // 未登录期间新配的 key 落 local-v1(mock 的 dataOwnerStorageKey 为恒等映射)。
        seedOwnerSlots(userData, [{ owner: 'local-v1', mtimeMs: 1 }]);
        expect(resolveOwnerScopedSecretStorageKeyForRead('provider_key_sub_codex')).toBe(
          'owner_local-v1_provider_key_sub_codex',
        );
      } finally {
        sessionState.mode = previousMode;
        sessionState.dataOwnerId = previousOwnerId;
        Object.assign(electronState, previousElectron);
        fs.rmSync(userData, { recursive: true, force: true });
      }
    });

    it('云账号在场 → 普通键严格自己的槽位,绝不读他人槽位(隔离回归锁)', () => {
      const previousMode = sessionState.mode;
      const previousOwnerId = sessionState.dataOwnerId;
      const previousElectron = { ...electronState };
      const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'xdt-read-strict-cloud-'));
      sessionState.mode = 'cloud';
      sessionState.dataOwnerId = 'cloud-current';
      electronState.userData = userData;
      try {
        // 别的账号槽位有同名凭证,当前账号没有 → 必须解析到自己(不存在的)键,而不是回落。
        // 用 api_key(网关计费凭证,非共享键):它有账号归属,共享会串号。
        const secretDir = path.join(userData, 'safe-storage');
        fs.mkdirSync(secretDir, { recursive: true });
        fs.writeFileSync(path.join(secretDir, 'owner_aaaa0000000000000000_api_key.enc'), 'x');
        expect(resolveOwnerScopedSecretStorageKeyForRead('api_key')).toBe(
          'owner_cloud-current_api_key',
        );
      } finally {
        sessionState.mode = previousMode;
        sessionState.dataOwnerId = previousOwnerId;
        Object.assign(electronState, previousElectron);
        fs.rmSync(userData, { recursive: true, force: true });
      }
    });

    /**
     * 共享键语义(2026-09-12 用户明确:「就一份,大家都能读到」):
     * 自定义供应商凭证(provider_key_* / provider_headers_*)不挂账号 ——
     * 任何账号态写入都落 local-v1 共享槽,任何账号态读取都是同一份。
     */
    describe('共享键(自定义供应商凭证)', () => {
      it('严格解析:任何账号态(含云账号)都落 local-v1 共享槽', () => {
        const previousOwnerId = sessionState.dataOwnerId;
        sessionState.mode = 'cloud';
        sessionState.dataOwnerId = 'cloud-user-1';
        try {
          expect(resolveOwnerScopedSecretStorageKey('provider_key_sub_codex')).toBe(
            'owner_local-v1_provider_key_sub_codex',
          );
        } finally {
          sessionState.dataOwnerId = previousOwnerId;
        }
      });

      it('云账号在场读取共享键:共享槽没有 → 仍回落任意 owner 槽位最新的存量(跨账号共享)', () => {
        const previousMode = sessionState.mode;
        const previousOwnerId = sessionState.dataOwnerId;
        const previousElectron = { ...electronState };
        const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'xdt-shared-cloud-'));
        sessionState.mode = 'cloud';
        sessionState.dataOwnerId = 'cloud-user-1';
        electronState.userData = userData;
        try {
          const secretDir = path.join(userData, 'safe-storage');
          fs.mkdirSync(secretDir, { recursive: true });
          // 共享化之前各账号配的存量:账号 A 旧、账号 B 新 → 读 B 那份。
          const fileA = path.join(secretDir, 'owner_aaaa0000000000000000_provider_key_sub_codex.enc');
          const fileB = path.join(secretDir, 'owner_bbbb0000000000000000_provider_key_sub_codex.enc');
          fs.writeFileSync(fileA, 'x');
          fs.writeFileSync(fileB, 'x');
          fs.utimesSync(fileA, new Date(1000), new Date(1000));
          fs.utimesSync(fileB, new Date(2000), new Date(2000));
          expect(resolveOwnerScopedSecretStorageKeyForRead('provider_key_sub_codex')).toBe(
            'owner_bbbb0000000000000000_provider_key_sub_codex',
          );
        } finally {
          sessionState.mode = previousMode;
          sessionState.dataOwnerId = previousOwnerId;
          Object.assign(electronState, previousElectron);
          fs.rmSync(userData, { recursive: true, force: true });
        }
      });

      it('共享槽已有该键 → 任何账号态都优先共享槽,不再回落', () => {
        const previousMode = sessionState.mode;
        const previousOwnerId = sessionState.dataOwnerId;
        const previousElectron = { ...electronState };
        const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'xdt-shared-first-'));
        sessionState.mode = 'cloud';
        sessionState.dataOwnerId = 'cloud-user-1';
        electronState.userData = userData;
        try {
          const secretDir = path.join(userData, 'safe-storage');
          fs.mkdirSync(secretDir, { recursive: true });
          const sharedFile = path.join(secretDir, 'owner_local-v1_provider_key_sub_codex.enc');
          fs.writeFileSync(sharedFile, 'x');
          fs.utimesSync(sharedFile, new Date(1), new Date(1));
          const fileB = path.join(secretDir, 'owner_bbbb0000000000000000_provider_key_sub_codex.enc');
          fs.writeFileSync(fileB, 'x');
          fs.utimesSync(fileB, new Date(9999), new Date(9999));
          // 共享槽虽旧但它是「当前生效的一份」;云槽位是共享化之前的陈旧残留。
          expect(resolveOwnerScopedSecretStorageKeyForRead('provider_key_sub_codex')).toBe(
            'owner_local-v1_provider_key_sub_codex',
          );
        } finally {
          sessionState.mode = previousMode;
          sessionState.dataOwnerId = previousOwnerId;
          Object.assign(electronState, previousElectron);
          fs.rmSync(userData, { recursive: true, force: true });
        }
      });
    });
  });
});

describe('readGhostSecretTailFromIo(尾指纹读取 + 老键懒回填)', () => {
  let io: ReturnType<typeof createMemoryIo>;

  beforeEach(() => {
    io = createMemoryIo();
    setProviderSecretsClearedListener(() => {});
  });

  it('已有预截指纹时直接回,不碰密文', () => {
    io.store.set(ghostSecretHintStorageKey('my-ghost', 'api_key'), '1234');
    expect(readGhostSecretTailFromIo(io, 'my-ghost', 'api_key')).toBe('1234');
  });

  it('老键无指纹但密文存在 → 懒回填:补截落库并返回', () => {
    io.store.set(ghostSecretStorageKey('my-ghost', 'api_key'), 'mivo_abcdefgh5678');
    expect(readGhostSecretTailFromIo(io, 'my-ghost', 'api_key')).toBe('5678');
    // 回填已落库,下次直接命中预截值。
    expect(io.store.get(ghostSecretHintStorageKey('my-ghost', 'api_key'))).toBe('5678');
  });

  it('官方别名键(xd-mivo 老用户)同样能懒回填', () => {
    io.store.set(ghostSecretStorageKey('xd-mivo', 'mivo_api_key'), 'mivo_legacy_key_9999');
    expect(readGhostSecretTailFromIo(io, 'xd-mivo', 'mivo_api_key')).toBe('9999');
    expect(io.store.get(ghostSecretHintStorageKey('xd-mivo', 'mivo_api_key'))).toBe('9999');
  });

  it('没存过 / 值太短不产指纹 → null 且不落回填键', () => {
    expect(readGhostSecretTailFromIo(io, 'my-ghost', 'api_key')).toBeNull();
    io.store.set(ghostSecretStorageKey('my-ghost', 'api_key'), 'short');
    expect(readGhostSecretTailFromIo(io, 'my-ghost', 'api_key')).toBeNull();
    expect(io.store.has(ghostSecretHintStorageKey('my-ghost', 'api_key'))).toBe(false);
  });

  it('io 抛错 → 吞掉回 null(端点侧降级成只显示已保存)', () => {
    const throwing: SecretStorageIo = {
      isAvailable: () => true,
      read: () => {
        throw new Error('boom');
      },
      write: () => false,
      remove: () => ({ success: true }),
      list: () => [],
    };
    expect(readGhostSecretTailFromIo(throwing, 'my-ghost', 'api_key')).toBeNull();
  });
});

describe('providerSecretStore account boundary (clearAll + reconcileOwner)', () => {
  let io: ReturnType<typeof createMemoryIo>;

  beforeEach(() => {
    io = createMemoryIo();
    setProviderSecretsClearedListener(() => {});
  });

  it('clearAll removes every registered provider secret', () => {
    const store = createProviderSecretStore(io);
    store.set('xd', 'sk-x');
    store.set('mivo', 'mivo_m');
    io.store.set(REMOTE_MCP_BRIDGE_TOKEN_STORAGE_KEY, 'remote-token');
    io.store.set(PI_PROXY_DERIVATION_KEY_STORAGE_KEY, 'pi-key');
    store.clearAll();
    expect(store.get('xd')).toBeNull();
    expect(store.get('mivo')).toBeNull();
    expect(io.store.has(REMOTE_MCP_BRIDGE_TOKEN_STORAGE_KEY)).toBe(false);
    expect(io.store.has(PI_PROXY_DERIVATION_KEY_STORAGE_KEY)).toBe(false);
  });

  it('换账号清理连带动态键名密钥：provider_oauth_* blob 与 provider_key_* 自定义 key', () => {
    const store = createProviderSecretStore(io);
    store.reconcileOwner('user-A');
    io.store.set('provider_oauth_acme', '{"access_token":"at-A"}');
    io.store.set('provider_key_myor_claude-code', 'sk-custom-A');
    io.store.set('unrelated_key', 'keep-me');
    const res = store.reconcileOwner('user-B');
    expect(res).toEqual({ cleared: true });
    expect(io.store.has('provider_oauth_acme')).toBe(false);
    expect(io.store.has('provider_key_myor_claude-code')).toBe(false);
    expect(io.store.get('unrelated_key')).toBe('keep-me'); // 前缀外的键不受影响
  });

  it('clearAll also sweeps dynamic custom MCP bearer tokens (mcp_token_*)', () => {
    const store = createProviderSecretStore(io);
    store.set('xd', 'sk-x');
    // 自定义 MCP token 键是动态的,不走 provider 枚举,直接写进底层 IO 模拟 safeStorage 落盘。
    io.store.set(customMcpSecretStorageKey('dida365'), 'mcp-secret-1');
    io.store.set(customMcpSecretStorageKey('slack'), 'mcp-secret-2');
    store.clearAll();
    expect(store.get('xd')).toBeNull();
    expect(io.store.has(customMcpSecretStorageKey('dida365'))).toBe(false);
    expect(io.store.has(customMcpSecretStorageKey('slack'))).toBe(false);
  });

  it('clearAll 连带清扫意识 network 槽凭证(ghost_secret_*)与尾指纹(ghost_hint_*)', () => {
    const store = createProviderSecretStore(io);
    io.store.set(ghostSecretStorageKey('web-search', 'brave_api_key'), 'BSA-xxx');
    io.store.set(ghostSecretStorageKey('web-search', 'tavily_api_key'), 'tvly-xxx');
    io.store.set(ghostSecretHintStorageKey('my-ghost', 'api_key'), '1234');
    io.store.set('unrelated_key', 'keep-me');
    store.clearAll();
    expect(io.store.has(ghostSecretStorageKey('web-search', 'brave_api_key'))).toBe(false);
    expect(io.store.has(ghostSecretStorageKey('web-search', 'tavily_api_key'))).toBe(false);
    expect(io.store.has(ghostSecretHintStorageKey('my-ghost', 'api_key'))).toBe(false);
    expect(io.store.get('unrelated_key')).toBe('keep-me');
  });

  it('reconcileOwner for a different user clears custom MCP tokens (no cross-account bleed)', () => {
    const store = createProviderSecretStore(io);
    store.reconcileOwner('user-A');
    io.store.set(customMcpSecretStorageKey('dida365'), 'A-token');
    const res = store.reconcileOwner('user-B');
    expect(res).toEqual({ cleared: true });
    expect(io.store.has(customMcpSecretStorageKey('dida365'))).toBe(false);
  });

  it('reconcileOwner on first login (no prior owner) keeps keys and records owner', () => {
    const store = createProviderSecretStore(io);
    store.set('xd', 'sk-x'); // 模拟升级前本机已有 key
    const res = store.reconcileOwner('user-A');
    expect(res).toEqual({ cleared: false });
    expect(store.get('xd')).toBe('sk-x'); // 升级后首次登录不丢 key
    expect(store.getOwnerUserId()).toBe('user-A');
  });

  it('reconcileOwner for the same user keeps keys (logout / expiry re-login)', () => {
    const store = createProviderSecretStore(io);
    store.reconcileOwner('user-A');
    store.set('xd', 'sk-x');
    store.set('mivo', 'mivo_m');
    const res = store.reconcileOwner('user-A');
    expect(res).toEqual({ cleared: false });
    expect(store.get('xd')).toBe('sk-x');
    expect(store.get('mivo')).toBe('mivo_m');
  });

  it('reconcileOwner for a different user clears keys and updates owner (no cross-account bleed)', () => {
    const store = createProviderSecretStore(io);
    store.reconcileOwner('user-A');
    store.set('xd', 'sk-A');
    store.set('mivo', 'mivo_A');
    const res = store.reconcileOwner('user-B');
    expect(res).toEqual({ cleared: true });
    expect(store.get('xd')).toBeNull();
    expect(store.get('mivo')).toBeNull();
    expect(store.getOwnerUserId()).toBe('user-B');
  });

  it('owner-scoped reconcile invalidates memory caches once per committed owner without clearing files', () => {
    sessionState.mode = 'cloud';
    sessionState.dataOwnerId = 'user-A';
    const listener = vi.fn();
    setProviderSecretsClearedListener(listener);
    const ownerScopedIo = { ...io, ownerScoped: true };
    const store = createProviderSecretStore(ownerScopedIo);

    expect(store.reconcileOwner('user-A')).toEqual({ cleared: false });
    expect(listener).toHaveBeenCalledTimes(1);
    expect(store.reconcileOwner('user-A')).toEqual({ cleared: false });
    expect(listener).toHaveBeenCalledTimes(1);

    sessionState.dataOwnerId = 'user-B';
    io.store.set('owner_user-A_provider_oauth_acme', 'token-A');
    io.store.set('owner_user-B_provider_oauth_acme', 'token-B');
    expect(store.reconcileOwner('user-B')).toEqual({ cleared: false });
    expect(listener).toHaveBeenCalledTimes(2);
    expect(io.store.get('owner_user-A_provider_oauth_acme')).toBe('token-A');
    expect(io.store.get('owner_user-B_provider_oauth_acme')).toBe('token-B');
  });
});
