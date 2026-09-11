import { useEffect, useState, startTransition } from 'react';

export function isWindowVisiblyFocused(): boolean {
  return document.visibilityState === 'visible' && document.hasFocus();
}

export function isDocumentVisible(): boolean {
  return document.visibilityState === 'visible';
}

export function useWindowVisible(enabled = true): boolean {
  const [visible, setVisible] = useState(() => {
    if (!enabled) return false;
    if (typeof document === 'undefined') return true;
    return isWindowVisiblyFocused();
  });

  useEffect(() => {
    if (!enabled) {
      setVisible(false);
      return undefined;
    }
    // blur/focus 的可见性翻转走并发调度（2026-09-11 性能修复）：事件处理器内的
    // setState 会触发**同步**全树重渲染，实测窗口失焦一次同步卡 6.6 秒
    // （LoAF 归因 DOMWindow.onblur → useWindowVisible.update）。可见性翻转不是
    // 紧急更新，startTransition 降级为可中断的并发渲染，长帧随之消失。
    const update = () => {
      startTransition(() => {
        setVisible(isWindowVisiblyFocused());
      });
    };
    update();
    document.addEventListener('visibilitychange', update);
    window.addEventListener('focus', update);
    window.addEventListener('blur', update);
    return () => {
      document.removeEventListener('visibilitychange', update);
      window.removeEventListener('focus', update);
      window.removeEventListener('blur', update);
    };
  }, [enabled]);

  return visible;
}

export function useDocumentVisible(enabled = true): boolean {
  const [visible, setVisible] = useState(() => {
    if (!enabled) return false;
    if (typeof document === 'undefined') return true;
    return isDocumentVisible();
  });

  useEffect(() => {
    if (!enabled) {
      setVisible(false);
      return undefined;
    }
    // 同 update:可见性翻转降级为并发调度,避免同步长帧(2026-09-11 性能修复)。
    const update = () => {
      startTransition(() => {
        setVisible(isDocumentVisible());
      });
    };
    update();
    document.addEventListener('visibilitychange', update);
    return () => {
      document.removeEventListener('visibilitychange', update);
    };
  }, [enabled]);

  return visible;
}
