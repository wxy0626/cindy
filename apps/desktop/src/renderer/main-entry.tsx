import { createRoot } from 'react-dom/client';

import '@fontsource-variable/inter';
import '@fontsource-variable/jetbrains-mono';
import 'harmonyos-sans-sc-webfont-splitted';

// <model-viewer> 已改为 ModelLightbox 内按需懒加载(2026-09-11 启动提速):
// 该库 ~1MB+(含 three.js)且仅 3D 预览 lightbox 使用,不再阻塞启动主链路。

// 在任何 React 组件渲染前先 import 触发 i18next 同步 init —— 否则首屏 useTranslation
// 拿到的会是 fallback 英文文案再瞬切到目标语言，造成可见闪烁。
import '@/i18n';
import './themes/colors';

import { TopLevelErrorBoundary } from './components/error/TopLevelErrorBoundary';
import { AppCrashScreen } from './components/error/AppCrashScreen';
import { initTapdb } from './analytics/tapdbClient';
import { installScrollbarAutoHide } from './lib/scrollbarAutoHide';
import { bootstrapMemorySettingsFromMain } from './lib/memorySettingsStore';
import { LocaleProvider } from './hooks/useLocale';
import { getInitialThemeVariant, ThemeProvider } from './hooks/useTheme';
import { applyFontSettings, getInitialFontSettings } from './hooks/useFontSettings';
import { ConfirmDialogProvider } from './components/ui/confirm-dialog-provider';
import { initRsbBrowserBridge } from './features/right-sidebar/lib/rsbBrowserBridge';
import { isGhostPanelWindow } from './lib/ghostPanelWindow';
import { isSecondaryWindow } from './lib/secondaryWindow';
import { installHiddenAnimationGate } from './lib/hiddenAnimationGate';
import { installSwallowActivationClick } from './lib/swallowActivationClick';
import { installEarlyKeyDownCapture } from './lib/earlyKeyDownCapture';
import { getSwallowActivationClickEnabled } from './hooks/useSwallowActivationClickSettings';
import { bootstrapLocalThemesSync } from './themes/local-themes';
import { themeService } from './themes/theme-service';
import './styles/globals.css';
import './styles/sortable.css';

const disposeEarlyKeyDownCapture = installEarlyKeyDownCapture();
installScrollbarAutoHide();
// 隐藏期动画闸门需要在首屏前安装，避免窗口启动即隐藏时漏掉冻结状态。
const disposeHiddenAnimationGate = installHiddenAnimationGate();

let disposeForegroundRecoveryDiagnostics: (() => void) | undefined;
let disposeRenderLoopWatchdog: (() => void) | undefined;
let disposePerformanceTimelineCleanupInterval: (() => void) | undefined;
let disposeInteractionJankProbe: (() => void) | undefined;
let cancelDeferredInitialization: (() => void) | undefined;

// 这些初始化只同步 renderer 镜像或采集诊断，不参与首屏渲染。放到首个 root.render
// 之后的空闲任务，避免 IPC/监听器安装和首屏模块求值竞争主线程。
const scheduleDeferredInitialization = (): void => {
  let idleId: number | undefined;
  let timeoutId: number | undefined;
  let cancelled = false;
  const run = async (): Promise<void> => {
    if (cancelled) return;
    try {
      // .tsx 中泛型箭头函数必须写 <T,> 尾逗号，否则 <T> 会被 TS 解析为 JSX 标签导致整仓 typecheck 失败。
      const loadDeferred = async <T,>(name: string, load: () => Promise<T>): Promise<T | null> => {
        try {
          return await load();
        } catch (error) {
          window.electronAPI?.logToMain?.(
            'warn',
            'renderer/boot',
            `deferred-import-failed stage=${name} elapsedMs=${Math.round(performance.now())} error=${String(error)}`,
          );
          return null;
        }
      };
      // 非关键模块（voice/settings/embedding/lsp/git/diagnostics/watchdog/jank）
      // 并行加载（A/B 基线 2026-09-15）：与「串行+yield」变体对照。二者都只在
      // 首个 root.render 后的空闲窗口执行，不阻塞首屏；HMR dispose 语义保留。
      const [voiceSettings, silentRetry, chatEmbedding, lspMode, gitSafety, diagnostics, renderLoop, jank] =
        await Promise.all([
          loadDeferred('voice-settings', () => import('./hooks/useVoiceInputSettings')),
          loadDeferred('silent-retry', () => import('./lib/silentEncryptedRetryStore')),
          loadDeferred('chat-embedding', () => import('./lib/chatEmbeddingStore')),
          loadDeferred('lsp-mode', () => import('./lib/lspModeStore')),
          loadDeferred('git-safety', () => import('./lib/gitSafetySettingsStore')),
          loadDeferred('diagnostics', () => import('./lib/foregroundRecoveryDiagnostics')),
          loadDeferred('render-loop', () => import('./lib/renderLoopWatchdog')),
          import.meta.env.DEV && !isVoiceInputOverlay && !isVoiceInputDictionaryToast
            ? loadDeferred('interaction-jank', () => import('./lib/interactionJankProbe'))
            : Promise.resolve(null),
        ]);
      if (cancelled) return;
      if (voiceSettings) {
        voiceSettings.migrateLegacyVoiceInputRendererStorage();
        void voiceSettings.syncVoiceInputGlobalShortcut(
          voiceSettings.getVoiceInputSettings().shortcut,
        );
      }
      void silentRetry?.bootstrapSilentEncryptedRetryFromMain();
      void chatEmbedding?.bootstrapChatEmbeddingFromMain();
      void lspMode?.bootstrapLspModeFromMain();
      void gitSafety?.bootstrapGitSafetySettingsFromMain();
      if (diagnostics) {
        disposeForegroundRecoveryDiagnostics = diagnostics.installForegroundRecoveryDiagnostics();
        if (import.meta.env.DEV) {
          disposePerformanceTimelineCleanupInterval =
            diagnostics.installPerformanceTimelineCleanupInterval();
        }
      }
      if (renderLoop) disposeRenderLoopWatchdog = renderLoop.installRenderLoopWatchdog();
      if (jank) disposeInteractionJankProbe = jank.installInteractionJankProbe();
    } catch (error) {
      window.electronAPI?.logToMain?.(
        'warn',
        'renderer/boot',
        `deferred-init-failed elapsedMs=${Math.round(performance.now())} error=${String(error)}`,
      );
    }
  };
  const requestIdleCallback = (
    window as Window & {
      requestIdleCallback?: (cb: () => void, options?: { timeout?: number }) => number;
    }
  ).requestIdleCallback;
  if (requestIdleCallback) {
    idleId = requestIdleCallback(run, { timeout: 2000 });
  } else {
    timeoutId = window.setTimeout(run, 0);
  }
  cancelDeferredInitialization = () => {
    cancelled = true;
    if (idleId !== undefined) {
      const cancelIdleCallback = (
        window as Window & {
          cancelIdleCallback?: (id: number) => void;
        }
      ).cancelIdleCallback;
      cancelIdleCallback?.(idleId);
    }
    if (timeoutId !== undefined) window.clearTimeout(timeoutId);
  };
};

const view = new URLSearchParams(window.location.search).get('view');
const isVoiceInputOverlay = view === 'voice-input-overlay';
const isVoiceInputDictionaryToast = view === 'voice-input-dictionary-toast';
const isComputerPermissionGuide = view === 'computer-permission-guide';
const isComputerPermissionBackdrop = view === 'computer-permission-backdrop';
const isComputerPermissionView = isComputerPermissionGuide || isComputerPermissionBackdrop;
const isAppearanceUtilityView =
  isVoiceInputOverlay || isVoiceInputDictionaryToast || isComputerPermissionView;
document.documentElement.dataset.platform = window.electronAPI.platform;
document.documentElement.dataset.windowBackdropMaterial =
  window.electronAPI.windowBackdropMaterial ?? 'none';
const disposeWindowBackdropMaterialChanged =
  window.electronAPI.onWindowBackdropMaterialChanged?.((material) => {
    document.documentElement.dataset.windowBackdropMaterial = material;
  }) ?? (() => {});
import.meta.hot?.dispose(disposeWindowBackdropMaterialChanged);
if (isVoiceInputOverlay || isVoiceInputDictionaryToast) {
  document.documentElement.dataset.voiceInputOverlay = 'true';
}
if (isComputerPermissionView) {
  document.documentElement.dataset.computerPermissionOverlay = 'true';
}

// Windows-only: emulate macOS `acceptFirstMouse: false` so a click that
// activates the window from background doesn't fall through to any in-page
// target. Skip on voice-input overlay windows — those are click-through
// popups (focusable:false, acceptFirstMouse:true by design).
const disposeSwallowActivationClick =
  !isVoiceInputOverlay && !isVoiceInputDictionaryToast && !isComputerPermissionView
    ? installSwallowActivationClick({
        window,
        platform: window.electronAPI?.platform ?? '',
        performanceNow: (): number => performance.now(),
        // 用户偏好每次事件回调都实时读一次 localStorage,toggle 立即生效。
        isEnabled: getSwallowActivationClickEnabled,
      })
    : (): void => {};

// dev-only: React 19 的 development 构建会为每个组件每次 commit 发一条 performance.measure
// (⚛ Components track), 且永不清理。长时间挂着 dev 跑 + 流式聊天高频重渲染会让性能时间线
// 堆到数 GB(堆外存储、GC 回收不掉), 最终把 renderer 撑爆 OOM 自动重载, 循环往复。
// 这里定时清空时间线缓冲兜底: 没有任何业务代码读这些 measure, 清空无副作用。
// production 构建里 react-dom 根本不发这些 measure, 且 import.meta.env.DEV 为 false 整段被
// tree-shake, 故对正式包零影响。
// 注意: 若你正在用 DevTools 的 Performance 面板录制 React profile, 会被这次清空打断 ——
// 录制期间临时把这段注释掉即可。
import.meta.hot?.dispose(() => {
  cancelDeferredInitialization?.();
  disposeForegroundRecoveryDiagnostics?.();
  disposeRenderLoopWatchdog?.();
  disposeHiddenAnimationGate();
  disposeEarlyKeyDownCapture();
  disposePerformanceTimelineCleanupInterval?.();
  disposeSwallowActivationClick();
  disposeInteractionJankProbe?.();
});

bootstrapLocalThemesSync();
themeService.applyTheme(getInitialThemeVariant().theme);
applyFontSettings(getInitialFontSettings());
const disposeUtilityAppearanceSettingsSync = isAppearanceUtilityView
  ? (window.electronAPI.appearanceSettings?.onChanged?.(applyFontSettings) ?? (() => {}))
  : (): void => {};
import.meta.hot?.dispose(disposeUtilityAppearanceSettingsSync);

// 启动提速(2026-09-11): 主视图路径原本严格串行 —— await memory 真值同步(IPC)
// 之后才开始 import('./App')(巨型业务模块图,启动最大单点)。两者互不依赖,
// 这里在模块顶层就并行发起,下方 async IIFE 里只做汇合 —— App 模块图的解析
// 执行与 IPC 往返重叠,砍掉一整段串行等待。
// 浮窗(appearance utility)分支不发起:浮窗不 render App,也不消费 memory 设置,
// 维持原副作用约束。ghost/secondary 副窗口与主视图同路径,行为不变(仅时序提前)。
const appModulePromise = isAppearanceUtilityView ? null : import('./App');
const memorySettingsPromise = isAppearanceUtilityView
  ? null
  : (() => {
      const startedAt = performance.now();
      window.electronAPI?.logToMain?.('debug', 'renderer/boot', 'memory-settings-start');
      const memoryPromise = bootstrapMemorySettingsFromMain();
      // Attach rejection handling to the source promise immediately: Promise.race alone
      // would leave a late IPC rejection unhandled after the timeout wins.
      let timeoutId: number | undefined;
      const observedMemoryPromise = memoryPromise.then(
        (value) => {
          if (timeoutId !== undefined) window.clearTimeout(timeoutId);
          window.electronAPI?.logToMain?.(
            'debug',
            'renderer/boot',
            `memory-settings-resolve elapsedMs=${Math.round(performance.now() - startedAt)}`,
          );
          return value;
        },
        (error) => {
          if (timeoutId !== undefined) window.clearTimeout(timeoutId);
          window.electronAPI?.logToMain?.(
            'warn',
            'renderer/boot',
            `memory-settings-reject elapsedMs=${Math.round(performance.now() - startedAt)} error=${String(error)}`,
          );
          return undefined;
        },
      );
      const timeoutPromise = new Promise<void>((resolve) => {
        timeoutId = window.setTimeout(() => {
          window.electronAPI?.logToMain?.(
            'warn',
            'renderer/boot',
            `memory-settings-timeout elapsedMs=${Math.round(performance.now() - startedAt)}`,
          );
          resolve();
        }, 4000);
      });
      return Promise.race([observedMemoryPromise, timeoutPromise]);
    })();

// 启动提速(2026-09-12 路由拆分配套): 主功能汇合组与 App 壳【并行】发起。
// 背景: router.tsx 路由级懒加载把 MainLayout/cc-agent 移出 App 壳,由 LocalDbGate
// 汇合驱动 AppShellCover 撤除(见 LocalDbGate.mainChunksReady)。若等 LocalDbGate
// mount(壳渲染完成后)才发起,这段加载会串行到关键路径上(实测串行 ~12s,
// 抵消壳瘦身的全部收益)。这里与 import('./App') 同时发起——ES module 缓存保证
// LocalDbGate 中的同 URL import 命同一 promise 或直接 resolve,汇合语义不变。
// 错误静默:仅预热,失败由 LocalDbGate/渲染层按原路径重试。
const mainChunksWarmupPromise = isAppearanceUtilityView
  ? null
  : Promise.all([
      import('@/components/layout/MainLayout'),
      import('@/features/cc-agent/CCAgentFeatureLayout'),
      import('@/features/cc-agent/CCAgentIndexRedirect'),
    ]);
void mainChunksWarmupPromise?.catch(() => {
  /* 预热失败不阻塞:真正加载由 LocalDbGate 汇合逻辑负责 */
});

const rootElement = document.getElementById('root');
if (!rootElement) {
  throw new Error('Missing #root element');
}
const root = createRoot(rootElement);

void (async () => {
  try {
    if (isComputerPermissionBackdrop) {
      const { ComputerPermissionBackdrop } =
        await import('./components/settings/ComputerPermissionGuideWindow');
      root.render(
        <ThemeProvider syncWindowVibrancy={false}>
          <ComputerPermissionBackdrop />
        </ThemeProvider>,
      );
      return;
    }

    if (isComputerPermissionGuide) {
      const { ComputerPermissionGuideWindow } =
        await import('./components/settings/ComputerPermissionGuideWindow');
      root.render(
        <ThemeProvider syncWindowVibrancy={false}>
          <LocaleProvider>
            <ComputerPermissionGuideWindow />
          </LocaleProvider>
        </ThemeProvider>,
      );
      return;
    }

    if (isVoiceInputDictionaryToast) {
      const { VoiceInputDictionaryToast } = await import('./voice-input/VoiceInputDictionaryToast');
      root.render(
        <ThemeProvider syncWindowVibrancy={false}>
          <LocaleProvider>
            <VoiceInputDictionaryToast />
          </LocaleProvider>
        </ThemeProvider>,
      );
      return;
    }

    if (isVoiceInputOverlay) {
      const { VoiceInputOverlay } = await import('./voice-input/VoiceInputOverlay');
      root.render(
        <ThemeProvider syncWindowVibrancy={false}>
          <LocaleProvider>
            <ConfirmDialogProvider>
              <VoiceInputOverlay />
            </ConfirmDialogProvider>
          </LocaleProvider>
        </ThemeProvider>,
      );
      return;
    }

    // Install the RSB control listener before any child Settings effect can ask
    // main for health. It is renderer-process scoped and must survive collapsed
    // or unmounted sidebar UI. Only the primary and dedicated sidebar windows
    // can own RSB tabs; other full-app windows must not publish an empty pool
    // snapshot into the primary registry.
    if (!isGhostPanelWindow() && !isSecondaryWindow()) {
      const disposeRsbBrowserBridge = initRsbBrowserBridge();
      import.meta.hot?.dispose(disposeRsbBrowserBridge);
    }

    // 主视图挂载前完成 memory 真值同步与旧配置迁移，确保用户可交互的 toggle 不会和
    // 启动快照并发。浮窗不消费该设置，跳过同步以免多个 renderer 争写共享 localStorage。
    // (promise 已在模块顶层提前发起，这里仅汇合 —— 等待时间已与 App 模块图重叠。)
    await (memorySettingsPromise ?? bootstrapMemorySettingsFromMain());

    // TapDB 在线活跃上报 — 只在主视图启用,避免 voice-input 浮窗的弹出被算成 PV。
    // 这里只挂"同意闸":SDK 是否初始化由 main 的 analytics-settings 决定,用户没
    // 同意过《隐私政策》时一个字节都不会发出去(见 analytics/tapdbClient.ts)。
    initTapdb();

    // 顶层 boundary:App 内 RouterProvider 之上的 provider 链渲染崩溃时兜底
    // (路由子树的崩溃仍由 router.tsx 的 errorElement 就近接住)。
    // App 必须延迟到辅助窗口分流之后再加载:完整 App 的 useApiKey 等模块会在
    // ghost/secondary renderer 启动时触发 safe-storage-read,被 main 正确拒绝并制造噪声。
    // (主视图/ghost/secondary 已在模块顶层提前发起 import，这里直接汇合;
    //  浮窗走原路径动态加载。)
    const { App } = await (appModulePromise ?? import('./App'));
    // 启动分段打点（2026-09-12）：App 巨图（动态 import）加载+求值完成的时刻，
    // 与 entry-start / main-entry-eval-done / gate 打点对齐即可分解 uptime→gate 的 43s。
    window.electronAPI?.logToMain?.(
      'debug',
      'renderer/boot',
      `app-graph-ready uptimeMs=${Math.round(performance.now())}`,
    );
  root.render(
    <TopLevelErrorBoundary>
      <App />
    </TopLevelErrorBoundary>,
  );
  // renderer root ready 改由 App 首次 commit 的 effect 上报（见 App.tsx），
  // root.render() 同步返回时 React 尚未提交，此处上报会早于真实可渲染。
  scheduleDeferredInitialization();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const stack = error instanceof Error ? error.stack : undefined;
    window.electronAPI?.logToMain?.(
      'error',
      'renderer/boot',
      `app-graph-failed elapsedMs=${Math.round(performance.now())} error=${message}`,
    );
    root.render(<AppCrashScreen message={message} stack={stack} />);
  }
})();
