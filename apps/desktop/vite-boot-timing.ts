import type { Plugin } from 'vite';

/**
 * Dev 启动计时探针（2026-09-12「继续优化」轮次引入）。
 *
 * 背景：anchor→App started 的前置段（实测 ~50s）里，forge boot / vite dev server
 * 启动 / 22 个串行构建目标之间的边界在日志里没有时间戳，无法定位大头。本探针在
 * vite 配置层打绝对 ISO 时间戳，与链路里已有的免费时间源对齐即可分段：
 *
 *   [boot-timing] dev-remote-env spawn（dev-remote-env.mjs）
 *     → [boot-timing] renderer.main_window config-resolved（renderer server 配置加载完）
 *     → [boot-timing] renderer.main_window server-listening（dev server 就绪，warmup 随即启动）
 *     → [boot-timing] main config-resolved（第一个构建目标的配置加载完）
 *     → 上午x:xx:xx [plugin-vite] target built ×22（既有输出）
 *     → [logger] === App started ===（既有输出）
 *
 * 噪音控制（刻意为之）：
 *  - renderer 用 apply:'serve' 的完整探针 —— 生产构建（vite build）不加载，零影响；
 *  - main 在 dev 也是 vite build（forge "target built"），所以 main 只挂 configResolved
 *    打点（生产打包多一行日志，可接受）；
 *  - preload 配置被 ~15 个 worker 目标共享，打点会刷屏，刻意不挂 —— forge 的
 *    "target built" 行已覆盖其时间线。
 */
export function bootTimingPlugin(label: string): Plugin {
  const startedAt = Date.now();
  const stamp = (mark: string): string =>
    `[boot-timing] ${label} ${mark} +${((Date.now() - startedAt) / 1000).toFixed(1)}s @ ${new Date().toISOString()}`;
  return {
    name: `xdt-boot-timing-${label}`,
    apply: 'serve',
    configResolved() {
      // eslint-disable-next-line no-console -- vite 配置进程无应用 logger
      console.log(stamp('config-resolved'));
    },
    configureServer(server) {
      server.httpServer?.once('listening', () => {
        // eslint-disable-next-line no-console -- vite 配置进程无应用 logger
        console.log(stamp('server-listening'));
      });
      // dep 预扫描完成打点（2026-09-12 定位 24.5s 构建窗）：re-optimize 时扫描+预打包
      // 与 forge 串行构建同进程抢 CPU；scanProcessing 是 rolldown-vite 公开 Promise，
      // 类型在跨版本间有差异，这里运行时探测 + 防御性断言，探针失败静默不伤启动。
      // env-probe 行用于确认 environments 访问路径在当前 rolldown-vite 版本下是否可达。
      const serverLike = server as unknown as {
        environments?: Record<string, { depsOptimizer?: { scanProcessing?: Promise<void> } }>;
      };
      const clientEnv = serverLike.environments?.client;
      // eslint-disable-next-line no-console -- vite 配置进程无应用 logger
      console.log(stamp(`env-probe hasClientEnv=${clientEnv ? 'true' : 'false'}`));
      void clientEnv?.depsOptimizer?.scanProcessing?.then(
        () => {
          // eslint-disable-next-line no-console -- vite 配置进程无应用 logger
          console.log(stamp('deps-scan-done'));
        },
        () => {
          /* 扫描失败由 vite 自身错误日志负责，探针不重复报告 */
        },
      );
    },
  };
}

/** 构建型目标（main 等）用：configResolved + buildStart/buildEnd 全程打点，serve/build 均生效。
 * 2026-09-12 用于分解「main config→首目标」25.5s 固有构建窗（与 warmup/重优化无关）。 */
export function buildConfigTimingPlugin(label: string): Plugin {
  const startedAt = Date.now();
  const stamp = (mark: string): string =>
    `[boot-timing] ${label} ${mark} +${((Date.now() - startedAt) / 1000).toFixed(1)}s @ ${new Date().toISOString()}`;
  return {
    name: `xdt-build-timing-${label}`,
    configResolved() {
      // eslint-disable-next-line no-console -- vite 配置进程无应用 logger
      console.log(stamp('config-resolved'));
    },
    buildStart() {
      // eslint-disable-next-line no-console -- vite 配置进程无应用 logger
      console.log(stamp('build-start'));
    },
    buildEnd() {
      // eslint-disable-next-line no-console -- vite 配置进程无应用 logger
      console.log(stamp('build-end'));
    },
    writeBundle() {
      // eslint-disable-next-line no-console -- vite 配置进程无应用 logger
      console.log(stamp('write-bundle'));
    },
  };
}
