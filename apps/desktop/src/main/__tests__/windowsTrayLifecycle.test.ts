import { describe, expect, it, vi } from 'vitest';

import {
  hideWindowToWindowsTray,
  popUpWindowsTrayMenu,
  requestWindowsTrayQuit,
  shouldCreateWindowsTrayAtStartup,
  type WindowsTrayMenuHost,
  type WindowsTrayPopupMenu,
  type WindowsTrayWindow,
} from '../windowsTrayLifecycle';

/** Controllable BrowserWindow fake for fullscreen transition tests. */
function makeWindow(fullScreen: boolean): WindowsTrayWindow & {
  destroyed: boolean;
  emitLeaveFullScreen(): void;
} {
  let leaveFullScreenListener: (() => void) | null = null;
  return {
    destroyed: false,
    hide: vi.fn(),
    isDestroyed() {
      return this.destroyed;
    },
    isFullScreen: () => fullScreen,
    once: (_event, listener) => {
      leaveFullScreenListener = listener;
    },
    setFullScreen: vi.fn((next: boolean) => {
      fullScreen = next;
    }),
    emitLeaveFullScreen() {
      leaveFullScreenListener?.();
    },
  };
}

describe('Windows tray lifecycle', () => {
  it('hides a regular window immediately', () => {
    const window = makeWindow(false);

    hideWindowToWindowsTray(window);

    expect(window.hide).toHaveBeenCalledTimes(1);
    expect(window.setFullScreen).not.toHaveBeenCalled();
  });

  it('leaves fullscreen before hiding the window', () => {
    const window = makeWindow(true);

    hideWindowToWindowsTray(window);

    expect(window.setFullScreen).toHaveBeenCalledWith(false);
    expect(window.hide).not.toHaveBeenCalled();

    window.emitLeaveFullScreen();
    expect(window.hide).toHaveBeenCalledTimes(1);
  });

  it('does not hide a window destroyed during the fullscreen transition', () => {
    const window = makeWindow(true);

    hideWindowToWindowsTray(window);
    window.destroyed = true;
    window.emitLeaveFullScreen();

    expect(window.hide).not.toHaveBeenCalled();
  });

  it('quits without confirmation while no turn is active', () => {
    const confirmQuit = vi.fn(() => false);
    const quit = vi.fn();

    requestWindowsTrayQuit({ hasActiveTurn: () => false, confirmQuit, quit });

    expect(confirmQuit).not.toHaveBeenCalled();
    expect(quit).toHaveBeenCalledTimes(1);
  });

  it('keeps the app open when active-turn confirmation is cancelled', () => {
    const quit = vi.fn();

    requestWindowsTrayQuit({ hasActiveTurn: () => true, confirmQuit: () => false, quit });

    expect(quit).not.toHaveBeenCalled();
  });

  it('quits after active-turn confirmation', () => {
    const quit = vi.fn();

    requestWindowsTrayQuit({ hasActiveTurn: () => true, confirmQuit: () => true, quit });

    expect(quit).toHaveBeenCalledTimes(1);
  });
});

describe('Windows tray startup', () => {
  it('creates the tray icon at startup when Windows uses tray or has not chosen yet', () => {
    expect(shouldCreateWindowsTrayAtStartup('win32', 'tray')).toBe(true);
    expect(shouldCreateWindowsTrayAtStartup('win32', null)).toBe(true);
  });

  it('仍会创建托盘图标,关闭策略只决定关闭后的动作', () => {
    expect(shouldCreateWindowsTrayAtStartup('win32', 'quit')).toBe(true);
    expect(shouldCreateWindowsTrayAtStartup('win32', null)).toBe(true);
    expect(shouldCreateWindowsTrayAtStartup('win32', 'tray')).toBe(true);
  });

  it('非 Windows 不创建 Windows 托盘图标', () => {
    expect(shouldCreateWindowsTrayAtStartup('darwin', 'tray')).toBe(false);
  });
});

/** 托盘 fake:走原生 popUpContextMenu(不用 setContextMenu,避免吞掉 right-click)。 */
function makeTrayMenuHost(): WindowsTrayMenuHost & { destroyed: boolean } {
  return {
    destroyed: false,
    isDestroyed() {
      return this.destroyed;
    },
    popUpContextMenu: vi.fn(),
  };
}

/** 菜单 fake:记录 menu-will-close 监听,便于模拟点空处关闭。 */
function makePopupMenu(id: string): WindowsTrayPopupMenu & {
  id: string;
  emitMenuWillClose(): void;
} {
  let closeListener: (() => void) | null = null;
  return {
    id,
    once: vi.fn((_event, listener: () => void) => {
      closeListener = listener;
    }),
    emitMenuWillClose() {
      closeListener?.();
    },
  };
}

describe('Windows tray menu popup', () => {
  it('builds the menu on first popup and keeps it referenced for the next one', () => {
    const tray = makeTrayMenuHost();
    const built = makePopupMenu('built');
    const buildMenu = vi.fn(() => built);
    let retained: typeof built | null = null;
    const activeMenus = new Set<WindowsTrayPopupMenu>();
    const retainMenu = vi.fn((menu: typeof built) => {
      retained = menu;
    });

    expect(
      popUpWindowsTrayMenu({
        tray,
        menu: retained,
        buildMenu,
        retainMenu,
        retainActiveMenu: (menu) => activeMenus.add(menu),
        releaseActiveMenu: (menu) => activeMenus.delete(menu),
        onUnavailable: vi.fn(),
        onError: vi.fn(),
      }),
    ).toBe(true);
    expect(buildMenu).toHaveBeenCalledTimes(1);
    expect(retained).toBe(built);
    expect(activeMenus.has(built)).toBe(true);
    // 原生托盘弹出入口:点击别处/Esc 由系统自动收起菜单。
    expect(vi.mocked(tray.popUpContextMenu).mock.calls[0][0]).toBe(built);
    // 菜单关闭(点空处)后释放活动引用。
    built.emitMenuWillClose();
    expect(activeMenus.has(built)).toBe(false);

    // 第二次右键复用同一个菜单对象。
    expect(
      popUpWindowsTrayMenu({
        tray,
        menu: retained,
        buildMenu,
        retainMenu,
        retainActiveMenu: (menu) => activeMenus.add(menu),
        releaseActiveMenu: (menu) => activeMenus.delete(menu),
        onUnavailable: vi.fn(),
        onError: vi.fn(),
      }),
    ).toBe(true);
    expect(buildMenu).toHaveBeenCalledTimes(1);
    expect(tray.popUpContextMenu).toHaveBeenCalledTimes(2);
  });

  it('keeps an open menu alive while rebuilding after a language change', () => {
    const tray = makeTrayMenuHost();
    const menus = [makePopupMenu('zh-CN'), makePopupMenu('en')];
    const buildMenu = vi.fn(() => menus.shift() ?? makePopupMenu('exhausted'));
    const retainMenu = vi.fn();
    const activeMenus = new Set<WindowsTrayPopupMenu>();
    const retainActiveMenu = (menu: WindowsTrayPopupMenu): void => {
      activeMenus.add(menu);
    };
    const releaseActiveMenu = (menu: WindowsTrayPopupMenu): void => {
      activeMenus.delete(menu);
    };

    popUpWindowsTrayMenu({
      tray,
      menu: null,
      buildMenu,
      retainMenu,
      retainActiveMenu,
      releaseActiveMenu,
      onUnavailable: vi.fn(),
      onError: vi.fn(),
    });
    // invalidateWindowsTrayMenu() 把缓存置空后的下一次右键。
    popUpWindowsTrayMenu({
      tray,
      menu: null,
      buildMenu,
      retainMenu,
      retainActiveMenu,
      releaseActiveMenu,
      onUnavailable: vi.fn(),
      onError: vi.fn(),
    });

    expect(buildMenu).toHaveBeenCalledTimes(2);
    expect(activeMenus.size).toBe(2);
    // 两个菜单都关闭(例如语言切换前后各弹出过一次)后活动引用清零。
    for (const [menu] of retainMenu.mock.calls) {
      (menu as ReturnType<typeof makePopupMenu>).emitMenuWillClose();
    }
    expect(activeMenus.size).toBe(0);
  });

  it('reports a missing tray icon without building a menu', () => {
    const buildMenu = vi.fn(() => makePopupMenu('unused'));
    const onUnavailable = vi.fn();

    expect(
      popUpWindowsTrayMenu({
        tray: null,
        menu: null,
        buildMenu,
        retainMenu: vi.fn(),
        retainActiveMenu: vi.fn(),
        releaseActiveMenu: vi.fn(),
        onUnavailable,
        onError: vi.fn(),
      }),
    ).toBe(false);

    expect(onUnavailable).toHaveBeenCalledWith('no-tray');
    expect(buildMenu).not.toHaveBeenCalled();
  });

  it('reports a destroyed tray icon without building a menu', () => {
    const tray = makeTrayMenuHost();
    tray.destroyed = true;
    const buildMenu = vi.fn(() => makePopupMenu('unused'));
    const onUnavailable = vi.fn();

    expect(
      popUpWindowsTrayMenu({
        tray,
        menu: null,
        buildMenu,
        retainMenu: vi.fn(),
        retainActiveMenu: vi.fn(),
        releaseActiveMenu: vi.fn(),
        onUnavailable,
        onError: vi.fn(),
      }),
    ).toBe(false);

    expect(onUnavailable).toHaveBeenCalledWith('destroyed');
    expect(buildMenu).not.toHaveBeenCalled();
  });

  it('surfaces a failing popup instead of throwing into the tray event handler', () => {
    const tray = makeTrayMenuHost();
    const failure = new Error('popup rejected by the shell');
    const menu = makePopupMenu('failing');
    // 原生弹出失败(例如托盘图标被系统回收)时应走 onError 并释放活动引用。
    tray.popUpContextMenu = vi.fn(() => {
      throw failure;
    });
    const onError = vi.fn();
    const retainActiveMenu = vi.fn();
    const releaseActiveMenu = vi.fn();

    expect(
      popUpWindowsTrayMenu({
        tray,
        menu: null,
        buildMenu: () => menu,
        retainMenu: vi.fn(),
        retainActiveMenu,
        releaseActiveMenu,
        onUnavailable: vi.fn(),
        onError,
      }),
    ).toBe(false);

    expect(onError).toHaveBeenCalledWith(failure);
    expect(retainActiveMenu).toHaveBeenCalledWith(menu);
    expect(releaseActiveMenu).toHaveBeenCalledWith(menu);
  });

  it('surfaces a failing menu build', () => {
    const tray = makeTrayMenuHost();
    const failure = new Error('menu template rejected');
    const onError = vi.fn();

    expect(
      popUpWindowsTrayMenu({
        tray,
        menu: null,
        buildMenu: () => {
          throw failure;
        },
        retainMenu: vi.fn(),
        retainActiveMenu: vi.fn(),
        releaseActiveMenu: vi.fn(),
        onUnavailable: vi.fn(),
        onError,
      }),
    ).toBe(false);

    expect(onError).toHaveBeenCalledWith(failure);
  });
});
