/**
 * brandRegion — 本构建的区域身份(cn/global)与区域派生 appId 的运行时单点。
 *
 * 区域在**构建期**经 VITE_CINDY_AUTH_REGION 烘焙(main 走 vite.main.config.ts
 * 的 define,renderer 走标准 Vite env;生产由 desktopClientBuildEnv 注入,dev /
 * 未注入一律默认 global)。运行时不可切换——cn 与 global 是两个可并存的系统身份
 * (com.xd.cindycn / com.xd.cindy,与 mobile 同一套命名)。
 *
 * ⚠️ AUMID 三位一体:本文件的 CURRENT_APP_ID 必须与 NSIS appId(forge.config
 * 按同一 region 从 brandAppId() 取值)、快捷方式 AUMID 逐字符一致,否则
 * Windows toast 通知被静默丢弃。
 */

import {
  brandAppId,
  resolveCindyRegion,
  type CindyRegion,
} from '@cindy/maker-shared/brand-identity';

/**
 * 读取单程序启动时选择的区域；没有选择时才回退到构建默认值。
 * 主进程读取启动参数，renderer 读取 preload 暴露的同一份值。
 */
function resolveRuntimeRegion(): CindyRegion {
  const argument =
    typeof process !== 'undefined'
      ? process.argv.find((value) => value.startsWith('--cindy-region='))
      : undefined;
  const argumentRegion = argument?.split('=', 2)[1];
  if (argumentRegion === 'cn' || argumentRegion === 'global') return argumentRegion;
  if (typeof window !== 'undefined') {
    const rendererRegion = window.electronAPI?.currentCindyRegion;
    if (rendererRegion === 'cn' || rendererRegion === 'global') return rendererRegion;
  }
  return resolveCindyRegion(import.meta.env?.VITE_CINDY_AUTH_REGION);
}

/** 当前运行实例的区域；单程序通过启动参数切换，构建值仅作兜底。 */
export const CURRENT_CINDY_REGION: CindyRegion = resolveRuntimeRegion();

/** 本构建的系统身份 id(Windows AUMID / macOS bundle id)。 */
export const CURRENT_APP_ID: string = brandAppId(CURRENT_CINDY_REGION);
