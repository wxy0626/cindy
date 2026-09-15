/**
 * Renderer 模块图分发入口。
 *
 * 资源用量窗口、右侧栏独立子窗口与主应用共用同一个受信任 HTML/origin，
 * 但从这里开始加载不同的模块图。判断必须发生在任何主应用静态依赖之前，
 * 否则 ESM 会先执行语音、诊断和设置初始化。
 */

const urlParams = new URLSearchParams(window.location.search);
const isResourceUsageWindow = urlParams.get('resourceUsageWindow') === '1';
const isSidebarWindow = urlParams.get('sidebarWindow') === '1';
const ghostPanelWindowId = urlParams.get('ghostPanelWindow');

// 启动分段打点（2026-09-12 优化轮）：uptime→gate ready 稳定 ~43s 且与 vite 层
// 优化无关，这里从模块图分发入口开始打点，分解「模块求值 / App 图加载 / gate
// 等待」各段耗时。debug 级别，生产行为零变化。
window.electronAPI?.logToMain?.(
  'debug',
  'renderer/boot',
  `entry-start uptimeMs=${Math.round(performance.now())}`,
);

void (isResourceUsageWindow
  ? import('./resource-usage-entry')
  : isSidebarWindow
    ? import('./sidebar-window-entry')
    : ghostPanelWindowId
      ? import('./ghost-panel-window-entry')
      : import('./main-entry')
).then(
  () => {
    // 主分支：main-entry 模块体（含其静态依赖图与顶层初始化）求值完成的时刻。
    window.electronAPI?.logToMain?.(
      'debug',
      'renderer/boot',
      `main-entry-eval-done uptimeMs=${Math.round(performance.now())}`,
    );
  },
  (error: unknown) => {
    // 入口加载失败发生在 React boundary 之前，仍通过统一 renderer logger 落盘。
    window.electronAPI?.logToMain?.(
      'error',
      'renderer/entry',
      `renderer entry load failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  },
);
