import type { WindowsCloseBehavior } from '../shared/windowBehavior.js';

/** BrowserWindow surface needed to leave fullscreen before hiding to the Windows tray. */
export interface WindowsTrayWindow {
  hide(): void;
  isDestroyed(): boolean;
  isFullScreen(): boolean;
  once(event: 'leave-full-screen', listener: () => void): unknown;
  setFullScreen(fullScreen: boolean): void;
}

/** Dependencies for applying the same active-turn protection to tray-menu quit. */
export interface WindowsTrayQuitDependencies {
  hasActiveTurn(): boolean;
  confirmQuit(): boolean;
  quit(): void;
}

/** Tray surface needed to confirm the JS-driven menu still has a live icon. */
export interface WindowsTrayMenuHost {
  isDestroyed(): boolean;
  /**
   * 原生托盘菜单弹出入口。Electron 35+ 起 `Menu.popup()` 不带 window 参数时
   * 菜单不会在点空处自动关闭（必须再右键或选一项）,而 Tray.popUpContextMenu
   * 走系统通知区域的原生菜单,点击别处自动收起。
   */
  popUpContextMenu(menu: unknown): void;
}

/** 判断 Windows 启动时是否创建托盘图标;关闭策略只决定关窗动作,不决定图标存在。 */
export function shouldCreateWindowsTrayAtStartup(
  platform: NodeJS.Platform,
  _windowsCloseBehavior: WindowsCloseBehavior | null,
): boolean {
  return platform === 'win32';
}

/** Menu surface used to let Electron choose the native cursor position. */
export interface WindowsTrayPopupMenu {
  /**
   * 菜单关闭事件(点击别处/Esc/选中某项都会触发),用于释放活动菜单引用。
   * 取代原 Menu.popup 的 callback —— 后者在 Electron 35+ 已不再可靠。
   */
  once(event: 'menu-will-close', listener: () => void): unknown;
}

/** Dependencies for the JS-driven tray menu popup. */
export interface WindowsTrayMenuPopupDependencies<TMenu extends WindowsTrayPopupMenu> {
  tray: WindowsTrayMenuHost | null;
  /** Cached menu, or null when it must be (re)built — callers drop it on language change. */
  menu: TMenu | null;
  buildMenu(): TMenu;
  /** Hands the menu back to the caller, which keeps it referenced for the next popup. */
  retainMenu(menu: TMenu): void;
  /** Keeps an open menu alive even if the cached menu is invalidated. */
  retainActiveMenu(menu: TMenu): void;
  releaseActiveMenu(menu: TMenu): void;
  onUnavailable(reason: 'no-tray' | 'destroyed'): void;
  onError(error: unknown): void;
}

/**
 * Open the Windows tray menu ourselves on right-click.
 *
 * ⚠️ 不要改回 `tray.setContextMenu()`。那条路径把弹菜单整个交给 native 侧,
 * 一旦系统那次弹出失败,JS 侧既收不到事件也记不下日志,用户就只剩任务管理器可用。
 * 而且 `setContextMenu` 一旦设置,`right-click` 事件按设计不再 emit
 * (electron#5058,维护者明确说是预期行为),所以两种方式不能并存做双保险:
 * 设了它,这里的兜底就永远不会被触发。
 *
 * ⚠️ 也不要用 `menu.popup()` 弹出。Electron 35+ 起,不传 window 坐标的
 * `menu.popup()` 弹出的菜单**不会**在点击别处时自动关闭(必须再右键一次或选中
 * 某一项),行为退化;`tray.popUpContextMenu(menu)` 是"一次性弹出",既不接管
 * right-click 事件(上面的诊断日志仍然有效),又保留系统原生菜单的自动收起。
 */
export function popUpWindowsTrayMenu<TMenu extends WindowsTrayPopupMenu>(
  deps: WindowsTrayMenuPopupDependencies<TMenu>,
): boolean {
  const { tray } = deps;
  if (!tray) {
    deps.onUnavailable('no-tray');
    return false;
  }
  if (tray.isDestroyed()) {
    deps.onUnavailable('destroyed');
    return false;
  }

  try {
    const menu = deps.menu ?? deps.buildMenu();
    deps.retainMenu(menu);
    let released = false;
    const releaseMenu = (): void => {
      if (released) return;
      released = true;
      deps.releaseActiveMenu(menu);
    };
    deps.retainActiveMenu(menu);
    // 关闭时释放引用:原生菜单在点空处/Esc/选中某项后都会触发该事件。
    // 重复弹出同一菜单对象时会重复监听,故用 once;releaseMenu 本身幂等。
    menu.once('menu-will-close', releaseMenu);
    try {
      // 走托盘的原生弹出:系统会在点击别处/Esc 时自动收起菜单。
      // Menu.popup() 无 window 参数时在 Electron 35+ 不会自动关闭,故不用它。
      tray.popUpContextMenu(menu);
    } catch (error) {
      releaseMenu();
      throw error;
    }
    return true;
  } catch (error) {
    deps.onError(error);
    return false;
  }
}

/** Hide immediately, or wait for the native fullscreen transition to finish first. */
export function hideWindowToWindowsTray(window: WindowsTrayWindow): void {
  if (!window.isFullScreen()) {
    window.hide();
    return;
  }

  window.once('leave-full-screen', () => {
    if (!window.isDestroyed()) window.hide();
  });
  window.setFullScreen(false);
}

/** Quit directly while idle, but require explicit confirmation during an active turn. */
export function requestWindowsTrayQuit(deps: WindowsTrayQuitDependencies): void {
  if (deps.hasActiveTurn() && !deps.confirmQuit()) return;
  deps.quit();
}
