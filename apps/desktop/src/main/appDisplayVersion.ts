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

/**
 * 选择开发版显示的语义版本：上游主线标签优先，其次当前 checkout 标签，
 * 最后回落 Electron 包内版本，保证离线或未拉取标签时仍有稳定显示。
 */
export function resolveDevelopmentAppVersion(input: {
  packagedVersion: string;
  upstreamTag?: string | null;
  headTag?: string | null;
}): string {
  return (
    normalizeAppVersionTag(input.upstreamTag) ??
    normalizeAppVersionTag(input.headTag) ??
    input.packagedVersion
  );
}
