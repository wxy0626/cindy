// TODO(erickzhao): Remove this when upgrading to Vite 6 and converting to ESM
process.env.VITE_CJS_IGNORE_WARNING = 'true';

import path from 'node:path';
import { createRequire } from 'node:module';

import { namedHookWithTaskFn, PluginBase } from '@electron-forge/plugin-base';
import chalk from 'chalk';
import debug from 'debug';
import fs from 'fs-extra';
import { Listr, PRESET_TIMER } from 'listr2';
import { default as vite } from 'vite';

import ViteConfigGenerator from './ViteConfig';
import { viteDevServerUrls } from './config/vite.base.config';
import { isCriticalBuildTarget } from './target-classification';

import type { VitePluginConfig } from './Config';
import type {
  ForgeListrTask,
  ForgeMultiHookMap,
  ResolvedForgeConfig,
} from '@electron-forge/shared-types';
import type { AddressInfo } from 'node:net';

const d = debug('electron-forge:plugin:vite');

export default class VitePlugin extends PluginBase<VitePluginConfig> {
  private static alreadyStarted = false;

  public name = 'vite';

  private isProd = false;

  /**
   * Path to the root of the Electron app
   */
  private projectDir!: string;

  /**
   * Path where Vite output is generated. Usually `${projectDir}/.vite`
   */
  private baseDir!: string;

  private configGeneratorCache!: ViteConfigGenerator;

  private watchers: vite.Rollup.RollupWatcher[] = [];

  private servers: vite.ViteDevServer[] = [];

  // Matches the format of the default Vite logger
  private timeFormatter = new Intl.DateTimeFormat(undefined, {
    hour: 'numeric',
    minute: 'numeric',
    second: 'numeric',
  });

  init = (dir: string): void => {
    this.setDirectories(dir);

    d('hooking process events');
    process.on('exit', (_code) => {
      this.exitHandler({ cleanup: true });
    });
    process.on('SIGINT' as NodeJS.Signals, (_signal) => {
      this.exitHandler({ exit: true });
    });
  };

  public setDirectories(dir: string): void {
    this.projectDir = dir;
    this.baseDir = path.join(dir, '.vite');
  }

  /**
   * 构建目标专用 vite 解析（启动优化 2026-09-14）：fork 内静态 import 的 vite 解析到
   * 根目录 vite 6.4.3（Rollup），main 主包构建实测 23.9s+6.6s 写盘；desktop 包自己
   * 的 "vite" 别名是 rolldown-vite@7.3.1（实测 main 构建秒级）。这里用 createRequire
   * 从 <projectDir>/apps/desktop 解析项目内 vite 供 vite.build 使用，失败或
   * XDT_FORGE_USE_PROJECT_VITE=0 时回退根 vite。仅影响构建目标；renderer dev server
   * 仍用根 vite（renderer rolldown dev 已证伪会卡死，不得切换）。
   */
  private projectBuildVite: typeof vite | null | undefined;

  // renderer 快启模式状态（见 preStart 注释）。
  private cachedRendererMode = false;
  private rendererNames: string[] = [];
  private rendererRebuildInFlight = false;

  /**
   * warm 产物复用（启动优化 2026-09-14）：dev 启动时若目标自上次成功构建后所有
   * 输入文件 mtime 未变、且记录的输出文件齐全，则跳过构建直接复用 .vite 产物。
   * dev 全量构建 main+15 worker ≈ 11s，warm 命中时降到 ~0.5s 的 stat 校验。
   * 校验任何一步失败都返回 null → 正常走全量构建（fail-safe）。
   * XDT_VITE_BUILD_CACHE=0 可强制关闭复用。
   */
  private stampKey = (target: string): string =>
    target.replace(/[^a-zA-Z0-9]+/g, '_').slice(0, 120);

  private readFreshStamp = (
    target: string,
  ): { builtAt: number; inputs: string[]; outputs: string[] } | null => {
    if (this.isProd || process.env.XDT_VITE_BUILD_CACHE === '0') return null;
    try {
      const stampPath = path.join(
        this.baseDir,
        'build',
        '.xdt-stamps',
        `${this.stampKey(target)}.json`,
      );
      const stamp = fs.readJsonSync(stampPath) as {
        builtAt: number;
        inputs: string[];
        outputs: string[];
      };
      if (
        typeof stamp?.builtAt !== 'number' ||
        !Array.isArray(stamp.inputs) ||
        !Array.isArray(stamp.outputs) ||
        stamp.inputs.length === 0 ||
        stamp.outputs.length === 0
      ) {
        return null;
      }
      // 时钟松弛 2s：mtime 比较按"晚于构建时刻-2s"判失效。
      for (const file of stamp.outputs) {
        if (!fs.existsSync(file)) return null;
      }
      for (const rawFile of stamp.inputs) {
        // 兼容旧 stamp：?raw 等虚拟查询串要剥离后才能 stat（如 xxx.md?raw）。
        const file = rawFile.split('?')[0];
        let mtimeMs: number;
        try {
          mtimeMs = fs.statSync(file).mtimeMs;
        } catch {
          return null; // 输入文件被删除 = 源码变化
        }
        if (mtimeMs > stamp.builtAt - 2000) return null;
      }
      return stamp;
    } catch {
      return null;
    }
  };

  private writeBuildStamp = (
    target: string,
    inputs: string[],
    outputs: string[],
  ): void => {
    if (this.isProd || inputs.length === 0 || outputs.length === 0) return;
    try {
      const stampDir = path.join(this.baseDir, 'build', '.xdt-stamps');
      fs.mkdirpSync(stampDir);
      fs.writeJsonSync(path.join(stampDir, `${this.stampKey(target)}.json`), {
        builtAt: Date.now(),
        inputs,
        outputs,
      });
    } catch {
      // 缓存失败只影响下次复用，不阻断本次构建
    }
  };

  private resolveProjectBuildVite = (): typeof vite => {
    if (this.projectBuildVite !== undefined) return this.projectBuildVite;
    this.projectBuildVite = vite;
    if (process.env.XDT_FORGE_USE_PROJECT_VITE === '0') return vite;
    try {
      const projectRequire = createRequire(
        path.join(this.projectDir, 'apps', 'desktop', 'package.json'),
      );
      const projectVitePath = projectRequire.resolve('vite');
      const mod = projectRequire(projectVitePath) as { default?: typeof vite } & typeof vite;
      this.projectBuildVite = (mod.default ?? mod) as typeof vite;
      console.log(
        `[boot-experiment] build targets via project vite @ ${projectVitePath}`,
      );
    } catch (error) {
      console.log(
        `[boot-experiment] project vite unavailable, fallback to root vite: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
    return this.projectBuildVite;
  };

  private get configGenerator(): ViteConfigGenerator {
    return (this.configGeneratorCache ??= new ViteConfigGenerator(
      this.config,
      this.projectDir,
      this.isProd,
    ));
  }

  getHooks = (): ForgeMultiHookMap => {
    return {
      preStart: [
        namedHookWithTaskFn<'preStart'>(async (task) => {
          if (VitePlugin.alreadyStarted) return;
          VitePlugin.alreadyStarted = true;

          d(`preStart: preparing ${this.baseDir}`);
          // warm 产物复用（启动优化 2026-09-14）：dev 不再整目录删除 .vite——
          // 源码未变的构建目标会按 stamp 新鲜度直接复用上次产物（见 build 内
          // readFreshStamp）；不新鲜的目标原地重建覆盖。prod 保持全量删除。
          if (this.isProd) {
            await fs.remove(this.baseDir);
          }

          // renderer 预构建快启模式（启动优化 2026-09-15）：renderer 源码自上次
          // prod 构建后未变 → 跳过 dev server，Electron 直接 loadFile 预构建产物
          //（dev URL define 已改为运行时 env 表达式，不设 env 即文件模式）。
          // 任一 renderer 源码变化 → 回落 dev server 模式（HMR 完整保留），
          // 并在 postStart 后台重建 prod 产物供下次快启。XDT_RENDERER_MODE=server
          // 可强制 dev server 模式。
          const rendererNames = (this.config.renderer ?? [])
            .map((r) => r?.name)
            .filter((n): n is string => typeof n === 'string' && n.length > 0);
          const envKeyFor = (name: string): string =>
            // 与 vite.base.config getBuildDefine 的 envName 严格一致：
            // XDT_MAIN_WINDOW_VITE_DEV_SERVER_URL 形态。
            `XDT_${name.toUpperCase().replaceAll('-', '_')}_VITE_DEV_SERVER_URL`;
          this.cachedRendererMode =
            !this.isProd &&
            process.env.XDT_RENDERER_MODE !== 'server' &&
            rendererNames.length > 0 &&
            rendererNames.every((name) => !!this.readFreshStamp(`renderer_${name}`));
          this.rendererNames = rendererNames;
          if (this.cachedRendererMode) {
            for (const name of rendererNames) delete process.env[envKeyFor(name)];
          }

          return task?.newListr(
            [
              {
                title: 'Launching Vite dev servers for renderer process code...',
                task: async (_ctx, task) => {
                  if (this.cachedRendererMode) {
                    task.title =
                      'Skipped renderer dev servers (using cached renderer build)';
                    return;
                  }
                  const result = await this.launchRendererDevServers(task);
                  // dev URL env 已在 launchRendererDevServers 内用 resolvedUrls
                  // 同步注入；此处仅兜底清理（fast 模式下删除）。
                  for (const name of rendererNames) {
                    if (this.cachedRendererMode) {
                      delete process.env[
                        `XDT_${name.toUpperCase().replaceAll('-', '_')}_VITE_DEV_SERVER_URL`
                      ];
                    }
                  }
                  task.title =
                    'Launched Vite dev servers for renderer process code';
                  return result;
                },
                rendererOptions: {
                  persistentOutput: true,
                  timer: { ...PRESET_TIMER },
                },
              },
              // The main process depends on the `server.port` of the renderer process, so the renderer process is run first.
              {
                title: 'Building main process and preload bundles...',
                task: async (_ctx, task) => {
                  const deferred = process.env.XDT_DEFERRED_WORKERS === '1';
                  const result = await this.build(task, deferred ? 'critical' : 'all');
                  if (deferred) {
                    // Deferred worker builds intentionally run after critical startup bundles.
                    void this.build(undefined, 'deferred').catch((error: unknown) => {
                      d('deferred worker build failed', error);
                    });
                  }
                  task.title = 'Built main process and preload bundles';
                  return result;
                },
                rendererOptions: {
                  persistentOutput: true,
                  timer: { ...PRESET_TIMER },
                },
              },
            ],
            { concurrent: false },
          );
        }, 'Preparing Vite bundles'),
      ],
      prePackage: [
        namedHookWithTaskFn<'prePackage'>(async (task) => {
          this.isProd = true;
          await fs.remove(this.baseDir);

          return task?.newListr(
            [
              {
                title: 'Building main and preload targets...',
                task: async (_ctx, subtask) => {
                  const results = await this.build(subtask);
                  return results;
                },
              },
              {
                title: 'Building renderer targets...',
                task: async (_ctx, subtask) => {
                  const results = await this.buildRenderer(subtask);
                  return results;
                },
              },
            ],
            { concurrent: true },
          );
        }, 'Building production Vite bundles'),
      ],
      postStart: async (_config, child) => {
        d('hooking electron process exit');
        child.on('exit', () => {
          if (child.restarted) return;
          this.exitHandler({ cleanup: true, exit: true });
        });
        // Electron 起来后后台准备 renderer 产物，供下次启动走快启模式。
        // 默认走一次性重建（实证可靠：main_window 大图 watch 与 dev server 同进程
        // 时曾 6min+ 无 BUNDLE_END）；XDT_RENDERER_WATCH=1 可切常驻 watch 实验。
        if (process.env.XDT_RENDERER_WATCH === '1') {
          void this.startRendererWatchBuild();
        } else {
          void this.rebuildRendererInBackground();
        }
      },
      resolveForgeConfig: this.resolveForgeConfig,
      packageAfterCopy: this.packageAfterCopy,
    };
  };

  resolveForgeConfig = async (
    forgeConfig: ResolvedForgeConfig,
  ): Promise<ResolvedForgeConfig> => {
    forgeConfig.packagerConfig ??= {};

    if (forgeConfig.packagerConfig.ignore) {
      if (typeof forgeConfig.packagerConfig.ignore !== 'function') {
        console.error(
          chalk.yellow(`You have set packagerConfig.ignore, the Electron Forge Vite plugin normally sets this automatically.

Your packaged app may be larger than expected if you dont ignore everything other than the '.vite' folder`),
        );
      }
      return forgeConfig;
    }

    forgeConfig.packagerConfig.ignore = (file: string) => {
      if (!file) return false;

      // `file` always starts with `/`
      // @see - https://github.com/electron/packager/blob/v18.1.3/src/copy-filter.ts#L89-L93

      // Collect the files built by Vite
      return !file.startsWith('/.vite');
    };
    return forgeConfig;
  };

  packageAfterCopy = async (
    _forgeConfig: ResolvedForgeConfig,
    buildPath: string,
  ): Promise<void> => {
    const pj = await fs.readJson(path.resolve(this.projectDir, 'package.json'));

    if (!pj.main?.includes('.vite/')) {
      throw new Error(`Electron Forge is configured to use the Vite plugin. The plugin expects the
"main" entry point in "package.json" to be ".vite/*" (where the plugin outputs
the generated files). Instead, it is ${JSON.stringify(pj.main)}.`);
    }

    if (pj.config) {
      delete pj.config.forge;
    }

    await fs.writeJson(path.resolve(buildPath, 'package.json'), pj, {
      spaces: 2,
    });
  };

  // Main process, Preload scripts and Worker process, etc.
  build = async (task?: ForgeListrTask<null>, mode: 'all' | 'critical' | 'deferred' = 'all'): Promise<Listr | void> => {
    const configs = await this.configGenerator.getBuildConfigs();
    const deferredEnabled = process.env.XDT_DEFERRED_WORKERS === '1';
    const isCriticalConfig = (config: vite.UserConfig): boolean =>
      isCriticalBuildTarget(config.build?.rollupOptions?.input);
    const filteredConfigs = mode === 'all' || !deferredEnabled
      ? configs
      : configs.filter((config) => mode === 'critical' ? isCriticalConfig(config) : !isCriticalConfig(config));
    /**
     * Checks if the result of the Vite build is a Rollup watcher.
     * This should happen iff we're running `electron-forge start`.
     */
    const isRollupWatcher = (
      x:
        | vite.Rollup.RollupWatcher
        | vite.Rollup.RollupOutput
        | vite.Rollup.RollupOutput[],
    ): x is vite.Rollup.RollupWatcher =>
      x &&
      typeof x === 'object' &&
      'on' in x &&
      typeof x.on === 'function' &&
      'close' in x &&
      typeof x.close === 'function';

    /**
     * Rollup's `input` can be a string, an array of strings, or an object.
     * This function converts the input to a string for the Forge CLI to consume.
     *
     * @see https://rollupjs.org/configuration-options/#input
     */
    const parseInputOptionToString = (input: vite.Rollup.InputOption) => {
      if (typeof input === 'string') {
        return input;
      } else if (Array.isArray(input)) {
        return input.join(' ');
      } else {
        return Object.keys(input).join(' ');
      }
    };

    return task?.newListr(
      filteredConfigs.map((userConfig) => {
        let target = '';
        const input = userConfig.build?.rollupOptions?.input;
        if (input) {
          target = parseInputOptionToString(input);
        } else if (
          typeof userConfig.build?.lib !== 'boolean' &&
          userConfig.build?.lib?.entry
        ) {
          target = parseInputOptionToString(userConfig.build.lib.entry);
        }

        return {
          title: `Building ${chalk.green(target)} target`,
          task: async (_ctx, subtask) => {
            // warm 产物复用：源码未变直接跳过（见 readFreshStamp 注释）。
            if (this.readFreshStamp(target)) {
              subtask.title = `Skipped ${chalk.green(target)} target (up-to-date)`;
              d('build cache hit for', target);
              return;
            }
            // 项目 rolldown-vite 仅用于 main 主包（2026-09-14 实测：main 构建 23.9s→5.8s）。
            // worker/utility 目标在 rolldown 下会挂起（docsOutputWriterUtilityProcess
            // 实证 4.5 分钟无完成事件），且它们在根 vite 下本就秒级——保留根 vite。
            const buildVite = target.includes('src/main/index')
              ? this.resolveProjectBuildVite()
              : vite;
            // 收集本次构建的真实输入/输出，成功后写 stamp 供下次 warm 复用。
            const pluginSelf = this;
            const inputFiles = new Set<string>();
            const outputFiles: string[] = [];
            const cacheProbePlugin = {
              name: 'xdt-fork-cache-probe',
              // 每轮构建周期重置输入清单：一次性构建无感，watch 模式下避免已删除
              // 文件残留在 stamp 里导致 statSync 失败、缓存永远判失效。
              buildStart() {
                inputFiles.clear();
              },
              transform(code: string, id: string) {
                // 剥离 ?raw 等虚拟查询串，stamp 里只存真实文件路径（否则 statSync 必失败）。
                if (!id.startsWith('\0') && code) inputFiles.add(id.split('?')[0]);
              },
              writeBundle(
                _options: unknown,
                bundle: Record<string, unknown>,
              ) {
                const rawOutDir = userConfig.build?.outDir;
                const outDir = rawOutDir
                  ? path.resolve(pluginSelf.projectDir, rawOutDir)
                  : path.join(pluginSelf.baseDir, 'build');
                for (const fileName of Object.keys(bundle)) {
                  if (fileName.endsWith('.js') || fileName.endsWith('.cjs')) {
                    outputFiles.push(path.join(outDir, fileName));
                  }
                }
              },
            };
            // We wrap this function in a Promise to ensure that the task is marked as completed
            // only after all bundles are done generated. This is done in the `closeBundle` Rollup hook
            // rather than when the `vite.build` promise resolves.
            await new Promise<void>((resolve, reject) => {
              buildVite
                .build({
                  // Avoid recursive builds caused by users configuring @electron-forge/plugin-vite in Vite config file.
                  configFile: false,
                  // We suppress Vite output and instead log lines using RollupWatcher events
                  logLevel: 'silent',
                  ...userConfig,
                  plugins: [
                    // warm 复用探针：收集输入/输出清单（见 readFreshStamp 注释）。
                    cacheProbePlugin,
                    // This plugin controls the output of the first-time Vite build that happens.
                    // `buildEnd` and `closeBundle` are Rollup output generation hooks.
                    // See https://rollupjs.org/plugin-development/#output-generation-hooks
                    {
                      name: '@electron-forge/plugin-vite:build-done',
                      buildEnd(err) {
                        if (err instanceof Error) {
                          d(
                            'buildEnd rollup hook called with error so build failed',
                          );
                          reject(err);
                        }
                      },
                      closeBundle() {
                        d(
                          'no error in buildEnd and reached closeBundle so build succeeded',
                        );
                        resolve();
                      },
                    },
                    ...(userConfig.plugins ?? []),
                  ],
                  clearScreen: false,
                })
                .then((result) => {
                  // When running `start` and enabling watch mode in Vite, the Rollup watcher
                  // emits events for subsequent builds.
                  if (isRollupWatcher(result)) {
                    result.on('event', (event) => {
                      if (
                        event.code === 'ERROR' &&
                        userConfig.logLevel !== 'silent'
                      ) {
                        console.error(
                          `\n${chalk.dim(this.timeFormatter.format(new Date()))} ${event.error.message}`,
                        );
                      } else if (
                        event.code === 'BUNDLE_END' &&
                        (!userConfig.logLevel || userConfig.logLevel === 'info')
                      ) {
                        console.log(
                          `${chalk.dim(this.timeFormatter.format(new Date()))} ${chalk.cyan.bold('[@electron-forge/plugin-vite]')} ${chalk.green(
                            'target built',
                          )} ${chalk.dim(target)}`,
                        );
                      }
                    });
                    this.watchers.push(result);
                  } else {
                    subtask.title = `Built target ${chalk.dim(target)}`;
                  }
                  return result;
                })
                .catch(reject);
            });
            // 构建成功 → 记录 stamp（输入文件清单 + 输出产物路径），供下次 warm 复用。
            this.writeBuildStamp(target, [...inputFiles], outputFiles);
          },
        };
      }),
      {
        concurrent: this.config.concurrent ?? true,
        exitOnError: this.isProd,
      },
    );
  };

  // Renderer process
  buildRenderer = async (task?: ForgeListrTask<null>) => {
    const rendererConfigs = await this.configGenerator.getRendererConfig();
    return task?.newListr(
      rendererConfigs.map((userConfig) => ({
        task: async (_ctx, subtask) => {
          await vite.build({
            configFile: false,
            logLevel: 'error',
            ...userConfig,
          });
          subtask.title = `Built target ${chalk.dim(path.basename(userConfig.build?.outDir ?? ''))}`;
        },
      })),
      {
        concurrent: this.config.concurrent ?? true,
      },
    );
  };

  /**
   * 后台重建单个 renderer 的 prod 产物（快启模式供给）。带 cacheProbe 采集
   * 输入/输出并写 stamp（key = renderer_<name>），与构建目标共用新鲜度机制。
   * 使用根 vite（与 prePackage 路径一致，避免 rolldown 的 renderer 未验证风险）。
   */
  buildSingleRenderer = async (name: string): Promise<void> => {
    const rendererConfigs = await this.configGenerator.getRendererConfig();
    const names = (this.config.renderer ?? []).map((r) => r?.name);
    const index = names.indexOf(name);
    const userConfig = rendererConfigs[index];
    if (!userConfig) throw new Error(`renderer config not found: ${name}`);
    const pluginSelf = this;
    const inputFiles = new Set<string>();
    const outputFiles: string[] = [];
    const cacheProbePlugin = {
      name: 'xdt-fork-cache-probe-renderer',
      buildStart() {
        inputFiles.clear();
      },
      transform(code: string, id: string) {
        // 剥离 ?raw 等虚拟查询串，stamp 里只存真实文件路径。
        if (!id.startsWith('\0') && code) inputFiles.add(id.split('?')[0]);
      },
      writeBundle(_options: unknown, bundle: Record<string, unknown>) {
        const rawOutDir = userConfig.build?.outDir;
        const outDir = rawOutDir
          ? path.resolve(pluginSelf.projectDir, rawOutDir)
          : path.join(pluginSelf.baseDir, 'renderer', name);
        for (const fileName of Object.keys(bundle)) {
          if (fileName.endsWith('.html') || fileName.endsWith('.js') || fileName.endsWith('.css')) {
            outputFiles.push(path.join(outDir, fileName));
          }
        }
      },
    };
    await vite.build({
      configFile: false,
      logLevel: 'error',
      ...userConfig,
      // dev 解析出的 renderer 配置 command='serve'，可能带 watch 配置；
      // 这里是一次性 build，必须显式关闭 watch，否则 await 拿到的是
      // watcher 且首构建未完成就写 stamp。
      // emptyOutDir 同理必须关闭：清空 1000+ 产物文件会触发 safe-delete
      // 批量护栏（抛错/挂起）。旧哈希产物无害残留，index.html 只引用当前产物。
      build: { ...(userConfig.build ?? {}), watch: null, emptyOutDir: false },
      plugins: [cacheProbePlugin, ...(userConfig.plugins ?? [])],
    });
    // HTML 入口经 transformIndexHtml 处理、不走 transform 钩子，手动计入 stamp，
    // 否则只改 index.html 不会使 renderer 缓存失效。renderer root = src/renderer，
    // html 约定为其下的 index.html。
    const rendererRoot = userConfig.root ?? path.join(pluginSelf.projectDir, 'src', 'renderer');
    const rendererInput = userConfig.build?.rollupOptions?.input;
    const rendererInputs = [
      ...inputFiles,
      path.resolve(rendererRoot, 'index.html'),
      ...(typeof rendererInput === 'string' ? [rendererInput] : []),
    ];
    this.writeBuildStamp(`renderer_${name}`, rendererInputs, outputFiles);
  };

  /** server 模式下 Electron 启动后的后台一次性重建（实证可靠路径）：
   *  为下次快启准备 renderer 产物。main_window 大图 watch 与 dev server 同进程时
   *  会长时间挂起（2026-09-15 实测 6min+ 无 BUNDLE_END），故默认走一次性重建。 */
  rebuildRendererInBackground = async (): Promise<void> => {
    if (this.isProd || this.cachedRendererMode || this.rendererRebuildInFlight) return;
    if (this.rendererNames.length === 0) return;
    this.rendererRebuildInFlight = true;
    // 备货状态文件（launcher 等待 2026-09-15）：dev-window.log 是带缓冲写入，
    // launcher 运行中读不到本轮日志行（实测 segLen=0），故改用 stamp 同目录的
    // 同步 JSON 状态文件；launcher 在 ready 后轮询它决定是否继续等备货完成
    // （见 restart-desktop-remote.mjs waitForBackgroundRendererStocking）。
    const stockingStatusPath = path.join(this.baseDir, 'build', '.xdt-stamps', 'stocking-status.json');
    const stockingStartedAt = Date.now();
    let stockingFailed = false;
    try {
      fs.writeJsonSync(stockingStatusPath, { state: 'running', startedAt: stockingStartedAt });
      for (const name of this.rendererNames) {
        if (this.readFreshStamp(`renderer_${name}`)) continue;
        const startedAt = Date.now();
        console.log(`[boot-experiment] background renderer build start: ${name}`);
        await this.buildSingleRenderer(name);
        console.log(
          `[boot-experiment] background renderer build done: ${name} +${((Date.now() - startedAt) / 1000).toFixed(1)}s`,
        );
      }
    } catch (error) {
      stockingFailed = true;
      console.log(
        `[boot-experiment] background renderer build failed: ${
          error instanceof Error ? `${error.message}\n${error.stack ?? ''}` : String(error)
        }`,
      );
    } finally {
      this.rendererRebuildInFlight = false;
      // 终态必须落盘：launcher 依据 done/failed 结束等待；durationMs 供耗时打印。
      try {
        fs.writeJsonSync(stockingStatusPath, {
          state: stockingFailed ? 'failed' : 'done',
          startedAt: stockingStartedAt,
          finishedAt: Date.now(),
          durationMs: Date.now() - stockingStartedAt,
        });
      } catch {
        /* 状态文件写失败不影响构建结果本身 */
      }
    }
  };

  /**
   * 常驻 renderer watch 构建（启动优化 2026-09-15）：在 dev 会话期间持续把
   * renderer 源码增量构建到 .vite/renderer 产物，并在每轮重建完成后刷新 stamp。
   * 效果：改 renderer 源码后【任意时刻重启】都命中快启缓存（17s 级），不再出现
   * "改一次代码 → 下一轮 30-40s" 的回落。dev server（HMR）与 watch 并存时
   * watch 是 CPU 背景任务（增量重建秒级）。与一次性重建二选一，watch 优先。
   */
  private rendererWatchStarted = false;

  startRendererWatchBuild = async (): Promise<void> => {
    if (this.isProd || this.rendererWatchStarted) return;
    this.rendererWatchStarted = true;
    const rendererConfigs = await this.configGenerator.getRendererConfig();
    const names = (this.config.renderer ?? []).map((r) => r?.name);
    for (let index = 0; index < rendererConfigs.length; index++) {
      const name = names[index];
      if (typeof name !== 'string' || !name) continue;
      const userConfig = rendererConfigs[index];
      const pluginSelf = this;
      const inputFiles = new Set<string>();
      const outputFiles: string[] = [];
      const cacheProbePlugin = {
        name: `xdt-fork-cache-probe-renderer-watch-${name}`,
        buildStart() {
          inputFiles.clear();
        },
        transform(code: string, id: string) {
          if (!id.startsWith('\0') && code) inputFiles.add(id.split('?')[0]);
        },
        writeBundle(_options: unknown, bundle: Record<string, unknown>) {
          const rawOutDir = userConfig.build?.outDir;
          const outDir = rawOutDir
            ? path.resolve(pluginSelf.projectDir, rawOutDir)
            : path.join(pluginSelf.baseDir, 'renderer', name);
          // 每轮 writeBundle 全量刷新输出清单（watch 重建后产物集合可能变化）。
          outputFiles.length = 0;
          for (const fileName of Object.keys(bundle)) {
            if (
              fileName.endsWith('.html') ||
              fileName.endsWith('.js') ||
              fileName.endsWith('.css')
            ) {
              outputFiles.push(path.join(outDir, fileName));
            }
          }
        },
        closeBundle() {
          // 每轮 watch 重建完成 → 刷新 stamp（builtAt/inputs/outputs 全量更新），
          // 保证下一次重启的快启判定命中。html 入口不走 transform，手动计入。
          const rendererRoot =
            userConfig.root ?? path.join(pluginSelf.projectDir, 'src', 'renderer');
          const htmlInput = path.resolve(rendererRoot, 'index.html');
          pluginSelf.writeBuildStamp(`renderer_${name}`, [htmlInput, ...inputFiles], [
            ...outputFiles,
          ]);
        },
      };
      try {
        const watcher = await vite.build({
          configFile: false,
          logLevel: 'error',
          ...userConfig,
          build: {
            ...(userConfig.build ?? {}),
            watch: userConfig.build?.watch ?? {},
            // watch 模式必须关闭 emptyOutDir：每轮重建删 1000+ 产物文件会触发
            // safe-delete 批量护栏抛错并杀死整个 forge 进程。旧哈希产物无害残留
            // （index.html 只引用当前产物），需要清理时走 --clean 全量重建。
            emptyOutDir: false,
          },
          plugins: [cacheProbePlugin, ...(userConfig.plugins ?? [])],
        });
        if (
          watcher &&
          typeof watcher === 'object' &&
          'on' in watcher &&
          typeof (watcher as { on?: unknown }).on === 'function'
        ) {
          const rollupWatcher = watcher as unknown as {
            on: (event: string, cb: (event: { code: string; error?: Error }) => void) => void;
          };
          rollupWatcher.on('event', (event) => {
            if (event.code === 'ERROR') {
              console.log(
                `[boot-experiment] renderer watch ERROR (${name}): ${event.error?.message ?? 'unknown'}`,
              );
            } else if (event.code === 'BUNDLE_END') {
              console.log(`[boot-experiment] renderer watch rebuilt: ${name}`);
            }
          });
          this.watchers.push(watcher as vite.Rollup.RollupWatcher);
          console.log(`[boot-experiment] renderer watch started: ${name}`);
        } else {
          console.log(`[boot-experiment] renderer watch: non-watcher result for ${name}`);
        }
      } catch (error) {
        console.log(
          `[boot-experiment] renderer watch failed for ${name}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }
  };

  launchRendererDevServers = async (task?: ForgeListrTask<null>) => {
    const rendererConfigs = await this.configGenerator.getRendererConfig();
    const rendererNames = (this.config.renderer ?? []).map((r) => r?.name);
    return task?.newListr(
      rendererConfigs.map((userConfig, index) => ({
        title: `Target ${chalk.cyan(path.basename(userConfig.build?.outDir ?? ''))}`,
        task: async (_ctx, subtask) => {
          const viteDevServer = await vite.createServer({
            configFile: false,
            ...userConfig,
          });

          await viteDevServer.listen();
          const urls = getServerURLs(viteDevServer.resolvedUrls!);
          subtask.output = urls;

          this.servers.push(viteDevServer);

          // 启动提速（2026-09-15）：listen 完成即用 resolvedUrls 注入 dev URL env
          //（主包运行时 define 表达式读取）。必须在 launch 内同步设置——依赖
          // viteDevServerUrls map 的回调填充存在事件时序竞态，会导致 env 缺失、
          // 主进程静默回落文件模式加载旧产物。
          const name = rendererNames[index];
          if (typeof name === 'string' && name.length > 0) {
            const localUrl = viteDevServer.resolvedUrls?.local?.[0];
            if (localUrl) {
              process.env[
                `XDT_${name.toUpperCase().replaceAll('-', '_')}_VITE_DEV_SERVER_URL`
              ] = localUrl;
            }
          }

          if (viteDevServer.httpServer) {
            // Make sure that `getDefines` in VitePlugin.ts gets the correct `server.port`. (#3198)
            const addressInfo = viteDevServer.httpServer.address();
            const isAddressInfo = (
              x: AddressInfo | string | null,
            ): x is AddressInfo =>
              typeof x === 'object' ? typeof x?.address === 'string' : false;

            if (isAddressInfo(addressInfo)) {
              userConfig.server ??= {};
              userConfig.server.port = addressInfo.port;
            }
          }
        },
        rendererOptions: {
          persistentOutput: true,
        },
      })),
    );
  };

  exitHandler = (
    options: { cleanup?: boolean; exit?: boolean },
    err?: Error,
  ): void => {
    d('handling process exit with:', options);
    if (options.cleanup) {
      for (const watcher of this.watchers) {
        d('cleaning vite watcher');
        watcher.close();
      }
      this.watchers = [];

      for (const server of this.servers) {
        d('cleaning http server');
        server.close();
      }
      this.servers = [];
    }
    if (err) console.error(err.stack);
    if (options.exit) process.exit(0);
  };
}

/**
 * Get a string for Vite's printServerUrls function without actually printing it.
 * Allows us to set `task.output` to that value without having to pass a custom logger into Vite.
 * @see https://github.com/vitejs/vite/blob/42233d39674be808a6a1a79f1a6e44ed23ba0d61/packages/vite/src/node/logger.ts#L168-L188
 */
function getServerURLs(urls: vite.ResolvedServerUrls) {
  let output = '';
  const colorUrl = (url: string) =>
    chalk.cyan(url.replace(/:(\d+)\//, (_, port) => `:${chalk.bold(port)}/`));
  for (const url of urls.local) {
    output += `  ${chalk.green('➜')}  ${chalk.bold('Local')}:   ${colorUrl(url)}`;
  }
  for (const url of urls.network) {
    output += `  \n${chalk.green('➜')}  ${chalk.bold('Network')}: ${colorUrl(url)}`;
  }
  if (urls.network.length === 0) {
    output +=
      chalk.dim(`  \n${chalk.green('➜')}  ${chalk.bold('Network')}: use `) +
      chalk.bold('--host') +
      chalk.dim(' to expose');
  }

  return output;
}

export { VitePlugin };
