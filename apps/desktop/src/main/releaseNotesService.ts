/**
 * releaseNotesService.ts
 * ---------------------------------------------------------------------------
 * Fetches per-version release notes from the CDN, plus a version-index so the
 * renderer can show every unread notice at once after a cross-version upgrade.
 *
 * URL shapes:
 *   per-version:   {CDN_BASE}/notice/{platformKey}/{version}.json
 *   version index: {CDN_BASE}/notice/{platformKey}/index.json
 *     e.g. https://cdn.example.com/app/notice/darwin-arm64/index.json
 *          → ["0.0.31", "0.0.78", ..., "0.0.124"]  (sorted ascending)
 *
 * The platform key is the SAME `${process.platform}-${process.arch}` value
 * used by manifestService — release notes and hot-update manifests share the
 * platform-axis convention so they can live next to each other on the CDN.
 *
 * The renderer should never hit the CDN directly — base URL stays in main and
 * CORS is bypassed by routing through net.request.
 *
 * Returns null on any failure (404, network, parse) so the caller can decide
 * whether to surface an error toast.
 *
 * Successful fetches are cached in-memory (platform is constant for the life
 * of the process) to avoid hammering CDN when the user re-opens the dialog
 * from the sidebar.
 */

import { StringDecoder } from 'node:string_decoder';

import { net } from 'electron';

import {
  hasRenderableContent,
  type RawReleaseNotes,
} from '../shared/releaseNotesContent';

import { getBaseUrl, getPlatformKey } from './manifestService';
import { fetchLatestUpstreamReleaseVersion } from './upstreamReleaseService';
import { compareAppUpdateVersions } from './updateVersionPolicy';

import { createLogger } from './logger';

const log = createLogger('releaseNotesService');

// ── Types ──────────────────────────────────────────────────────────────────

// ── Constants ──────────────────────────────────────────────────────────────

const REQUEST_TIMEOUT_MS = 15_000;
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
const MAX_RETRIES = 3;
const RETRY_BASE_DELAY_MS = 1_000;
/** 长驻开发进程需要感知新发布的公告，索引不能缓存整个进程生命周期。 */
const INDEX_CACHE_TTL_MS = 60_000;

// ── State ──────────────────────────────────────────────────────────────────

const cache = new Map<string, RawReleaseNotes>();
const inFlight = new Map<string, Promise<RawReleaseNotes | null>>();

// Sorted ascending list of every version that has a notice JSON on the CDN
// for this platform. Cached briefly on success only — a failed fetch falls
// through so a subsequent call can retry.
let indexCache: { at: number; versions: string[] } | null = null;

// ── Core ───────────────────────────────────────────────────────────────────

/**
 * Result of a single CDN fetch attempt.
 * - `ok` + `data`: HTTP 200 + valid JSON.
 * - `null`: non-retryable failure (HTTP non-200, JSON parse error).
 * - `retryable` error: network error / timeout — caller can retry.
 */
type FetchAttempt<T> =
  | { ok: true; data: T }
  | { ok: false; retryable: boolean };

/**
 * Single attempt at fetching a JSON document from the CDN.
 * Resolves with structured result so the retry wrapper can decide whether to
 * back off and retry or give up immediately.
 */
function fetchCdnJsonOnce<T>(url: string): Promise<FetchAttempt<T>> {
  return new Promise((resolve) => {
    try {
      const request = net.request(url);
      const decoder = new StringDecoder('utf8');
      let body = '';
      let bodyBytes = 0;
      let settled = false;
      let aborted = false;

      const finish = (value: FetchAttempt<T>, abortRequest = false): void => {
        if (!settled) {
          settled = true;
          if (timeout) clearTimeout(timeout);
          resolve(value);
        }
        // Resource cleanup is independent of settling the business result.
        if (abortRequest && !aborted) {
          aborted = true;
          request.abort();
        }
      };
      const timeout = setTimeout(() => {
        log.info('Timeout: %s', url);
        finish({ ok: false, retryable: true }, true);
      }, REQUEST_TIMEOUT_MS);

      request.on('response', (response) => {
        response.on('error', (err) => {
          log.error('Response error for %s:', url, err);
          finish({ ok: false, retryable: true }, true);
        });
        response.on('aborted', () => finish({ ok: false, retryable: true }, true));
        if (settled) {
          finish({ ok: false, retryable: true }, true);
          return;
        }
        if (response.statusCode !== 200) {
          log.info('HTTP %d for %s', response.statusCode, url);
          // No error body is needed; don't leave an unread native loader alive.
          finish({ ok: false, retryable: false }, true);
          return;
        }

        response.on('data', (chunk) => {
          if (settled) return;
          bodyBytes += Buffer.byteLength(chunk);
          if (bodyBytes > MAX_RESPONSE_BYTES) {
            body = '';
            finish({ ok: false, retryable: false }, true);
            return;
          }
          body += decoder.write(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        });
        response.on('end', () => {
          if (settled) return;
          try {
            body += decoder.end();
            finish({ ok: true, data: JSON.parse(body) as T });
          } catch (err) {
            log.error('JSON parse failed for %s:', url, err);
            finish({ ok: false, retryable: false });
          }
        });
      });

      request.on('error', (err) => {
        log.error('Request error for %s:', url, err);
        finish({ ok: false, retryable: true }, true);
      });

      try {
        request.end();
      } catch (err) {
        log.error('Request start failed for %s:', url, err);
        finish({ ok: false, retryable: true }, true);
      }
    } catch (err) {
      log.error('Unexpected error for %s:', url, err);
      resolve({ ok: false, retryable: true });
    }
  });
}

/**
 * Fetch a JSON document from the CDN with retries for transient failures.
 *
 * Retryable (network error / timeout): up to MAX_RETRIES attempts with
 * exponential backoff (1s → 2s → 4s). Non-retryable (HTTP non-200, JSON parse
 * error): returns null immediately — no point re-fetching a definitive answer.
 *
 * Returns the parsed value on 200, null on any failure. Silent — caller decides
 * UX.
 */
async function fetchCdnJson<T>(url: string): Promise<T | null> {
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    if (attempt > 0) {
      const delayMs = RETRY_BASE_DELAY_MS * 2 ** (attempt - 1);
      log.info('Retry %d/%d for %s in %dms', attempt, MAX_RETRIES, url, delayMs);
      await new Promise((r) => setTimeout(r, delayMs));
    }

    const result = await fetchCdnJsonOnce<T>(url);
    if (result.ok) return result.data;
    if (!result.retryable) return null;
  }

  log.info('All retries exhausted for %s', url);
  return null;
}

/**
 * Fetch release notes JSON for a given version from CDN.
 * Platform is resolved internally via `getPlatformKey()` (same axis as the
 * hot-update manifest), so callers never need to pass it.
 * Returns null on 404 / network error / parse error (silent — caller decides UX).
 */
export async function fetchReleaseNotes(version: string): Promise<RawReleaseNotes | null> {
  const hit = cache.get(version);
  if (hit) return hit;

  const pending = inFlight.get(version);
  if (pending) return pending;

  const request = (async () => {
    const platform = getPlatformKey();
    // CDN 公告按明文版本命名（index.json 里只有 0.1.79 这类，无 -beta 后缀）；
    // 请求版本带预发布后缀（开发版 v0.1.79-beta 等）时先剥掉再拼 URL。
    const urlVersion = version.replace(/-.*$/, '');
    // Cache-bust to dodge stale CDN edges
    const url = `${getBaseUrl()}/notice/${platform}/${urlVersion}.json?t=${Date.now()}`;
    const json = await fetchCdnJson<RawReleaseNotes>(url);
    if (!json) return null;
    // A 200 payload with nothing renderable (e.g. a v2 document whose topics
    // are all malformed) is treated as a failed fetch and NOT cached — the
    // process-lifetime cache would otherwise keep serving the bad document
    // even after the CDN is corrected, and the renderer would reject it anyway.
    if (!hasRenderableContent(json)) {
      log.warn('Payload has no renderable content, treating as failure: version=%s', version);
      return null;
    }
    cache.set(version, json);
    log.info('Fetched OK: version=%s, sections=%d', json.version, json.sections?.length ?? 0);
    return json;
  })();
  inFlight.set(version, request);

  try {
    return await request;
  } finally {
    if (inFlight.get(version) === request) inFlight.delete(version);
  }
}

/**
 * Fetch the sorted list of every version that has a notice JSON on the CDN
 * for this platform. Used by the renderer to compute the range of unread
 * versions when a user upgrades across several releases and needs to see all
 * intermediate release notes at once.
 *
 * Payload: `["0.0.31", "0.0.78", ..., "0.0.124"]` — sorted ascending, no
 * duplicates. Anything unexpected (non-array / non-string entries) is
 * defensively filtered to keep bad CDN edges from crashing renderer code.
 *
 * Returns null on 404 / network / parse error. Successful results are cached
 * briefly so a running development build can pick up newly published notices.
 */
export async function fetchReleaseNotesIndex(): Promise<string[] | null> {
  if (indexCache && Date.now() - indexCache.at < INDEX_CACHE_TTL_MS) {
    return indexCache.versions;
  }

  const platform = getPlatformKey();
  const url = `${getBaseUrl()}/notice/${platform}/index.json?t=${Date.now()}`;
  // CDN 可能提前挂出尚未发布的公告；GitHub Releases 最新版才是可见性上限。
  // 两个请求并行，避免额外串行网络等待。
  const [json, upstreamLatest] = await Promise.all([
    fetchCdnJson<unknown>(url),
    fetchLatestUpstreamReleaseVersion(),
  ]);
  if (!Array.isArray(json)) {
    if (json !== null) log.warn('index.json is not an array; ignoring');
    return null;
  }
  const cdnVersions = json.filter((v): v is string => typeof v === 'string');
  // 上游版本不可用或公告版本不是合法 SemVer 时按隐藏处理，绝不展示无法确认的新版本。
  const versions = upstreamLatest === null
    ? []
    : cdnVersions.filter(
        (version) => compareAppUpdateVersions(version, upstreamLatest) !== 'newer',
      );
  indexCache = { at: Date.now(), versions };
  log.info(
    'Fetched index OK: %d/%d versions (upstream ceiling=%s)',
    versions.length,
    cdnVersions.length,
    upstreamLatest ?? 'unavailable',
  );
  return versions;
}

/**
 * 开发版公告版本解析（2026-09-15）：开发版的版号（0.0.0 或自打的 vX.Y.Z-beta）
 * 在 CDN 上没有对应公告，直接请求必然 404，用户侧表现为"获取更新公告失败"。
 * 这里在请求前对齐 CDN：版号去掉预发布后缀后若不在索引中，回落到索引里最新的
 * 上游发布版本，让开发版也能查看上游最新版本日志。离线/索引不可用时原样返回。
 */
export async function resolveAvailableReleaseNotesVersion(requested: string): Promise<string> {
  const normalized = requested.replace(/-.*$/, '');
  const index = await fetchReleaseNotesIndex();
  if (!index || index.length === 0) return normalized;
  if (index.includes(normalized)) return normalized;
  const newest = index[index.length - 1];
  log.info('Release notes version fallback: %s -> %s (not on CDN)', requested, newest);
  return newest;
}

/**
 * 开发版“当前版本”公告优先使用实际版本的公告；只有该版本尚未进入 CDN 索引时，
 * 才回落到索引里的最新版，避免 CDN 更高的预发布/未公开公告覆盖本地真实版本。
 * 显式历史版本仍走 resolveAvailableReleaseNotesVersion，不会被这里重写。
 */
export async function resolveLatestAvailableReleaseNotesVersion(
  requested: string,
): Promise<string> {
  const normalized = requested.replace(/-.*$/, '');
  const index = await fetchReleaseNotesIndex();
  if (index?.includes(normalized)) return normalized;
  const newest = index?.[index.length - 1];
  if (!newest) return normalized;
  log.info('Release notes current-version fallback: %s -> %s (not on CDN)', requested, newest);
  return newest;
}
