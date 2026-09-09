import { useCallback, useEffect, useRef, useState } from 'react';

import { useAuth } from '@/contexts/AuthContext';
import type { DesktopLoginAction } from '@/lib/authService';

interface UseLoginReturn {
  isLoading: boolean;
  errorCode: string | null;
  loginState: ReturnType<typeof useAuth>['loginState'];
  hasAccountDeletionReceipt: boolean;
  getAccountDeletionStatus: ReturnType<typeof useAuth>['getAccountDeletionStatus'];
  clearAccountDeletionReceipt: ReturnType<typeof useAuth>['clearAccountDeletionReceipt'];
  listAccounts: ReturnType<typeof useAuth>['listAccounts'];
  dispatch: (action: DesktopLoginAction) => Promise<boolean>;
  /** 登录页选择区域，并将主进程返回的 providers 状态投影到当前页面。 */
  selectLoginRegion: (region: 'cn' | 'global') => Promise<{ success: boolean; code: string | null }>;
  /**
   * 与 dispatch 同一条链路,但把失败码返回给调用方——captcha 兜底重试需要在
   * 调用点区分 CAPTCHA_REQUIRED/CAPTCHA_INVALID 与其他失败(errorCode state
   * 在同一 tick 内读不到新值)。busy 短路时 code 为 null(与 dispatch 静默
   * 返回 false 同口径,不产生可展示错误)。
   */
  dispatchWithResult: (
    action: DesktopLoginAction,
  ) => Promise<{ success: boolean; code: string | null }>;
  clearError: () => void;
  /**
   * 「跳过登录」必须走这里,不能直接调 `authEnterLocal` IPC。
   * AuthContext 会用返回值立刻改 `mode` / `canEnterApp`;绕过它只改主进程会话,
   * 界面仍停在登录页,再点一次也不会重播状态。
   */
  enterLocalMode: ReturnType<typeof useAuth>['enterLocalMode'];
  /** 启动添加账号流程，并由调用方导航到专用登录路由。 */
  beginAddAccount: ReturnType<typeof useAuth>['beginAddAccount'];
}

/** Coordinates presentation state while all credentials and tickets stay in main. */
const LOGIN_ACTION_TIMEOUT_MS = 20_000;

export function useLogin({ autoLoad = true }: { autoLoad?: boolean } = {}): UseLoginReturn {
  const {
    loginState,
    loadLoginState,
    dispatchLoginAction,
    selectLoginRegion: selectRegionInAuth,
    hasAccountDeletionReceipt,
    getAccountDeletionStatus,
    clearAccountDeletionReceipt,
    listAccounts,
    enterLocalMode,
    beginAddAccount,
  } = useAuth();
  const [isLoading, setIsLoading] = useState(false);
  const [errorCode, setErrorCode] = useState<string | null>(null);
  const loadingRef = useRef(false);
  const actionRequestIdRef = useRef(0);

  useEffect(() => {
    if (!autoLoad || loginState || loadingRef.current) return;
    const requestId = ++actionRequestIdRef.current;
    loadingRef.current = true;
    setIsLoading(true);
    void loadLoginState()
      .then((result) => {
        if (actionRequestIdRef.current === requestId && !result.success) {
          setErrorCode(result.code);
        }
      })
      .catch(() => {
        if (actionRequestIdRef.current === requestId) {
          setErrorCode('AUTH_SERVICE_UNAVAILABLE');
        }
      })
      .finally(() => {
        if (actionRequestIdRef.current === requestId) {
          loadingRef.current = false;
          setIsLoading(false);
        }
      });
  }, [autoLoad, loadLoginState, loginState]);

  const dispatchWithResult = useCallback(
    async (action: DesktopLoginAction): Promise<{ success: boolean; code: string | null }> => {
      // reset 是导航/取消动作，必须能够打断当前登录请求，不能被 loading 自己拦截。
      if (
        loadingRef.current &&
        action.type !== 'cancel-browser' &&
        action.type !== 'reset'
      ) {
        return { success: false, code: null };
      }
      const requestId = ++actionRequestIdRef.current;
      loadingRef.current = true;
      setIsLoading(true);
      setErrorCode(null);
      try {
        // IPC/网络异常不能让登录页永久停在 loading；超时后回收 loading 并给出可重试错误。
        const result = await Promise.race([
          dispatchLoginAction(action),
          new Promise<never>((_, reject) => {
            window.setTimeout(() => reject(new Error('AUTH_REQUEST_TIMEOUT')), LOGIN_ACTION_TIMEOUT_MS);
          }),
        ]);
        if (actionRequestIdRef.current !== requestId) {
          return { success: false, code: 'AUTH_FLOW_SUPERSEDED' };
        }
        if (!result.success) {
          setErrorCode(
            result.code === 'USER_CANCELLED' || result.code === 'AUTH_FLOW_SUPERSEDED'
              ? null
              : result.code,
          );
          return { success: false, code: result.code };
        }
        return { success: true, code: null };
      } catch (error) {
        if (actionRequestIdRef.current !== requestId) {
          return { success: false, code: 'AUTH_FLOW_SUPERSEDED' };
        }
        const code = error instanceof Error && error.message === 'AUTH_REQUEST_TIMEOUT'
          ? 'AUTH_REQUEST_TIMEOUT'
          : 'AUTH_REQUEST_FAILED';
        setErrorCode(code);
        return { success: false, code };
      } finally {
        // reset 可以在旧请求尚未结束时启动；旧请求不能提前清掉新请求的 loading。
        if (actionRequestIdRef.current === requestId) {
          loadingRef.current = false;
          setIsLoading(false);
        }
      }
    },
    [dispatchLoginAction],
  );

  const dispatch = useCallback(
    async (action: DesktopLoginAction): Promise<boolean> =>
      (await dispatchWithResult(action)).success,
    [dispatchWithResult],
  );

  const selectLoginRegion = useCallback(
    async (region: 'cn' | 'global'): Promise<{ success: boolean; code: string | null }> => {
      try {
        const result = await selectRegionInAuth(region);
        if (!result.success) return { success: false, code: result.code };
        return { success: true, code: null };
      } catch {
        return { success: false, code: 'AUTH_REQUEST_FAILED' };
      }
    },
    [selectRegionInAuth],
  );

  return {
    isLoading,
    errorCode,
    loginState,
    hasAccountDeletionReceipt,
    getAccountDeletionStatus,
    clearAccountDeletionReceipt,
    listAccounts,
    dispatch,
    selectLoginRegion,
    dispatchWithResult,
    clearError: () => setErrorCode(null),
    enterLocalMode,
    beginAddAccount,
  };
}
