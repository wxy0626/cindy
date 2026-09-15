/**
 * 上游发布版本查询（2026-09-15）：直读 GitHub Releases 订阅源
 * （https://github.com/makecindy/cindy/releases → releases.atom，含 beta/预发布），
 * 只负责"告诉你上游有哪些版本"，不做任何自动更新——是否更新由用户自行决定。
 *
 * 为什么不用 GitHub REST API：未鉴权限流是 60 次/小时且按出口 IP 计算，
 * 共享网络下极易被限死（本机实测已 403 rate limit）。releases.atom 是普通
 * Web 端点，无此限制，且内容与 releases 列表一一对应。
 */

import { net } from 'electron';

import { createLogger } from './logger';
import { normalizeAppVersionTag } from './appDisplayVersion';

const log = createLogger('upstreamRelease');

const RELEASES_ATOM_URL = 'https://github.com/makecindy/cindy/releases.atom';
const REQUEST_TIMEOUT_MS = 8_000;
/** 同一进程内的最小刷新间隔，避免频繁打开设置页重复拉取。 */
const MIN_REFRESH_INTERVAL_MS = 60_000;

export interface UpstreamRelease {
  /** 归一化后的语义版本（去 v 前缀，保留 -beta 等预发布后缀）。 */
  version: string;
  /** GitHub 上的原始 tag 名，例如 v0.1.81-beta。 */
  tag: string;
  name: string;
  /** Release 页面地址，供 UI 直接跳转。 */
  url: string;
  publishedAt: string | null;
  prerelease: boolean;
}

export interface UpstreamReleasesResult {
  ok: boolean;
  releases: UpstreamRelease[];
  /** 版本序最新的一个（含 beta；正式版高于同版本 beta）。 */
  latest: UpstreamRelease | null;
  /** 当前应用版本（开发版取解析后的展示版本）。 */
  currentVersion: string | null;
  /** latest 严格新于 currentVersion 时为真。 */
  hasNewer: boolean;
  error?: string;
}

/** 轻量 semver 比较：a>b 返回 1，a<b 返回 -1，相等返回 0。 */
function compareSemver(a: string, b: string): number {
  const parse = (value: string): { core: number[]; pre: string } => {
    const [corePart = '', prePart = ''] = value.split('-');
    const core = corePart.split('.').map((part) => Number.parseInt(part, 10) || 0);
    return { core, pre: prePart };
  };
  const left = parse(a);
  const right = parse(b);
  for (let i = 0; i < 3; i += 1) {
    const diff = (left.core[i] ?? 0) - (right.core[i] ?? 0);
    if (diff !== 0) return diff > 0 ? 1 : -1;
  }
  // 预发布版本低于同版本正式版；两者都无后缀时相等。
  if (left.pre === right.pre) return 0;
  if (!left.pre) return 1;
  if (!right.pre) return -1;
  return left.pre < right.pre ? -1 : 1;
}

function fetchAtomOnce(): Promise<string | null> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value: string | null): void => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    try {
      const request = net.request({
        url: RELEASES_ATOM_URL,
        headers: { 'User-Agent': 'Cindy-Desktop' },
      });
      const timer = setTimeout(() => {
        log.warn('upstream releases request timed out');
        try {
          request.abort();
        } catch {
          /* 已结束时忽略 */
        }
        finish(null);
      }, REQUEST_TIMEOUT_MS);
      request.on('response', (response) => {
        if (response.statusCode < 200 || response.statusCode >= 300) {
          log.warn('upstream releases HTTP %d', response.statusCode);
          clearTimeout(timer);
          finish(null);
          return;
        }
        const chunks: Buffer[] = [];
        response.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
        response.on('end', () => {
          clearTimeout(timer);
          finish(Buffer.concat(chunks).toString('utf8'));
        });
        response.on('error', () => {
          clearTimeout(timer);
          finish(null);
        });
      });
      request.on('error', (error) => {
        clearTimeout(timer);
        log.warn('upstream releases request error: %s', String(error));
        finish(null);
      });
      request.end();
    } catch (error) {
      log.warn('upstream releases setup failed: %s', String(error));
      finish(null);
    }
  });
}

/** 从 atom XML 解析发布条目（tag / 链接 / 时间），容错到"能解析多少算多少"。 */
function parseReleasesAtom(xml: string): UpstreamRelease[] {
  const entries = xml.split(/<entry[\s>]/).slice(1);
  const releases: UpstreamRelease[] = [];
  for (const entry of entries) {
    const linkMatch = /href="([^"]*\/releases\/tag\/([^"]+))"/.exec(entry);
    const idMatch = /Repository\/\d+\/([^<"]+)/.exec(entry);
    const titleMatch = /<title>([\s\S]*?)<\/title>/.exec(entry);
    const updatedMatch = /<updated>([\s\S]*?)<\/updated>/.exec(entry);

    // tag 优先取链接里的（最稳），其次 id，最后 title（title 可能带发布说明后缀）。
    const rawTag = linkMatch?.[2] ?? idMatch?.[1] ?? titleMatch?.[1] ?? null;
    const tag = rawTag ? decodeURIComponent(rawTag.trim()).split(/[\s:]/)[0] : null;
    const version = normalizeAppVersionTag(tag);
    if (!tag || !version) continue;
    releases.push({
      version,
      tag,
      name: titleMatch?.[1]?.trim() ?? tag,
      url: linkMatch?.[1] ?? `https://github.com/makecindy/cindy/releases/tag/${tag}`,
      publishedAt: updatedMatch?.[1]?.trim() ?? null,
      prerelease: version.includes('-'),
    });
  }
  releases.sort((a, b) => compareSemver(b.version, a.version));
  return releases;
}

let cache: { at: number; releases: UpstreamRelease[] } | null = null;

/** 拉取（必要时刷新）上游发布列表；失败时退回上次结果，都没有则返回 null。 */
async function loadReleases(force: boolean): Promise<UpstreamRelease[] | null> {
  if (!force && cache && Date.now() - cache.at < MIN_REFRESH_INTERVAL_MS) {
    return cache.releases;
  }
  const xml = await fetchAtomOnce();
  if (!xml) return cache?.releases ?? null;
  const releases = parseReleasesAtom(xml);
  if (releases.length === 0) return cache?.releases ?? null;
  cache = { at: Date.now(), releases };
  return releases;
}

/** 供 IPC 使用：给出上游版本列表 + 当前版本 + 是否有更新。 */
export async function fetchUpstreamReleases(options: {
  currentVersion: string | null;
  force?: boolean;
}): Promise<UpstreamReleasesResult> {
  const { currentVersion } = options;
  const releases = await loadReleases(options.force === true);
  if (!releases) {
    return {
      ok: false,
      releases: [],
      latest: null,
      currentVersion,
      hasNewer: false,
      error: 'unavailable',
    };
  }
  const latest = releases[0] ?? null;
  return {
    ok: true,
    releases,
    latest,
    currentVersion,
    // 版本序比较含预发布语义：v0.1.81-beta 低于 v0.1.81，但高于 v0.1.80。
    hasNewer: Boolean(
      latest && currentVersion && compareSemver(latest.version, currentVersion) > 0,
    ),
  };
}
