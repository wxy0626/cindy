/**
 * 开发版应用版本解析。正式包版本由 Electron 的 app.getVersion() 提供；
 * 未打包开发版则优先展示上游主线最近的发布标签，避免固定版本号随上游更新而过期。
 */

const VERSION_TAG_RE = /^v?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)$/;

/** 将 Git 标签安全地投影成应用可展示的版本号。 */
export function normalizeAppVersionTag(value: string | null | undefined): string | null {
  const match = typeof value === 'string' ? VERSION_TAG_RE.exec(value.trim()) : null;
  return match?.[1] ?? null;
}

function compareVersions(left: string, right: string): number {
  const parse = (value: string): { core: number[]; pre: string } => {
    const [corePart = '', pre = ''] = value.split('-', 2);
    return {
      core: corePart.split('.').map((part) => Number.parseInt(part, 10) || 0),
      pre,
    };
  };
  const a = parse(left);
  const b = parse(right);
  for (let index = 0; index < 3; index += 1) {
    const difference = (a.core[index] ?? 0) - (b.core[index] ?? 0);
    if (difference !== 0) return difference;
  }
  if (a.pre === b.pre) return 0;
  if (!a.pre) return 1;
  if (!b.pre) return -1;
  return a.pre < b.pre ? -1 : 1;
}

/**
 * 从同一发布线的 tag 中取最高版本。git describe 取的是离 ref 最近的 tag，
 * 不是语义版本最高的 tag；发布提交顺序与版本发布顺序不一致时会误选旧版。
 */
function latestVersionInReleaseLine(
  tags: string[],
  referenceVersion: string | null,
): string | null {
  const normalized = tags
    .map((tag) => normalizeAppVersionTag(tag))
    .filter((tag): tag is string => tag !== null);
  if (normalized.length === 0) return null;

  const referenceCore = referenceVersion?.split('-', 1)[0]?.split('.');
  const sameReleaseLine = referenceCore
    ? normalized.filter((tag) => {
        const core = tag.split('-', 1)[0]?.split('.');
        return core?.[0] === referenceCore[0] && core?.[1] === referenceCore[1];
      })
    : [];
  const candidates = referenceVersion ? sameReleaseLine : normalized;
  return [...candidates].sort(compareVersions).at(-1) ?? null;
}

/**
 * 选择开发版显示的语义版本：上游主线标签优先，其次当前 checkout 标签，
 * 最后回落 Electron 包内版本，保证离线或未拉取标签时仍有稳定显示。
 */
export function resolveDevelopmentAppVersion(input: {
  packagedVersion: string;
  upstreamTag?: string | null;
  /** origin/main 可达的版本 tag，不能只使用 git describe 返回的最近 tag。 */
  upstreamTags?: string[];
  headTag?: string | null;
}): string {
  const upstreamVersion = normalizeAppVersionTag(input.upstreamTag);
  return (
    latestVersionInReleaseLine(input.upstreamTags ?? [], upstreamVersion) ??
    upstreamVersion ??
    normalizeAppVersionTag(input.headTag) ??
    input.packagedVersion
  );
}
