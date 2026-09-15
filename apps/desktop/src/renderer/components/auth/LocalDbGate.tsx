import { useEffect, useRef, useState } from 'react';
import { Outlet, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';

import { useAppShellCover } from '@/contexts/AppShellCoverContext';
import { useAuth } from '@/contexts/AuthContext';
import { LocalDbFatalScreen } from '@/components/error/LocalDbFatalScreen';
import { createLogger } from '@/lib/logger';
import { toast } from '@/lib/toast';
import { formatBytes } from '@/features/cc-agent/workdir-browse/lib/fileMeta';

const log = createLogger('LocalDbGate');
const shownDbSlimmingResultIds = new Set<string>();

/**
 * 路由层 localDb 就绪门（前身 MigrationGate；chat-data 云端迁移已随主 server
 * 退役，本组件只保留"库就绪"职责）：
 *
 * - 入口已经过 ProtectedRoute（已认证）；这里只判断"主功能区是否可进入"。
 * - 调 `localDb.ensureReady(userId)`——按 userId 切换 / 兜底恢复 / 跑 schema
 *   migration。成功后渲染主功能 Outlet；失败：渲染 LocalDbFatalScreen 全屏
 *   恢复界面（MIGRATE_FAILED 时 main 不再弹 OS 对话框，恢复路径是安装已暂存
 *   的应用更新；其余 code 原生对话框照旧，本界面兜底展示错误详情）。
 * - ensureReady 成功后向 main 发 appReadyForBot 信号（IM bot 连接安全上线的
 *   前置条件），fire-and-forget。
 */
type GateDecision =
  | { phase: 'checking' }
  | { phase: 'ready' }
  | { phase: 'fatal'; code?: string; message?: string };

/**
 * decision 失败的有限重试。fatal 会切到全屏恢复界面、阻断整棵主功能 UI 树,必须
 * 只留给确定性失败;而这里的失败常常是 transient —— 2026-07-15 实锤过一例:
 * 跨系统睡眠的 db worker RPC 假超时把 ensureReady 打挂,一次挫折直接白屏到手动
 * Cmd+R。重试 2 次(间隔 1s)可消化这类瞬时故障,真死的 DbClient 依然会在
 * 第 3 次失败后落 fatal,保住"不永久停在 checking"的原有保证。
 */
const MAX_DECISION_RETRIES = 2;
const DECISION_RETRY_DELAY_MS = 1_000;

export function LocalDbGate() {
  const { t } = useTranslation();
  const { dataOwnerId, mode, logout, exitLocalMode } = useAuth();
  const { reportLocalDbGate } = useAppShellCover();
  const navigate = useNavigate();
  const [decision, setDecision] = useState<GateDecision>({ phase: 'checking' });
  const [retryNonce, setRetryNonce] = useState(0);
  const retryCountRef = useRef(0);
  const previousOwnerIdRef = useRef<string | null>(null);
  // 启动 readiness 上报一次性闸：HMR/StrictMode 重挂不重复上报（main 侧幂等，双保险）。
  const readinessReportedRef = useRef(false);
  // 主功能区模块预加载汇合（启动提速 2026-09-12）：路由拆分后（见 router.tsx
  // 路由级懒加载注释），MainLayout 与 cc-agent 落地链是 gate ready 后立刻渲染的
  // 模块。这里与 ensureReady 检查并行加载，并把「就绪」并入 cover 撤除条件——
  // AppShellCover（Splash）一直盖到主图可渲染，撤盖无闪帧。加载失败也放行
  // （渲染层 Suspense 会重试，好过永久盖屏）。
  const [mainChunksReady, setMainChunksReady] = useState(false);

  useEffect(() => {
    let alive = true;
    // 汇合组：gate ready 后必须立即可渲染的三个模块。
    void Promise.all([
      import('@/components/layout/MainLayout'),
      import('@/features/cc-agent/CCAgentFeatureLayout'),
      import('@/features/cc-agent/CCAgentIndexRedirect'),
    ]).then(
      () => {
        if (!alive) return;
        setMainChunksReady(true);
        // 错峰预热（不参与汇合）：默认落地链的二级页面（session 视图 = 上次
        // 会话恢复；new = 空列表兜底），在汇合组完成后追加，避免与关键路径
        // 抢带宽/transform 队列。
        void import('@/features/cc-agent/CCAgentSessionView');
        void import('@/features/cc-agent/NewMakerDraftRoute');
      },
      () => {
        if (alive) setMainChunksReady(true);
      },
    );
    return () => {
      alive = false;
    };
  }, []);

  // 启动分段打点（2026-09-12 拆分测量）：主图汇合完成的时刻——「用户可见」=
  // max(decision ready, 本时刻)，与 gate attempt / ready 行对比即可验证拆分收益。
  useEffect(() => {
    if (!mainChunksReady) return;
    window.electronAPI?.logToMain?.(
      'debug',
      'renderer/boot',
      `main-chunks-ready uptimeMs=${Math.round(performance.now())}`,
    );
  }, [mainChunksReady]);

  useEffect(() => {
    let cancelled = false;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    const ownerId = dataOwnerId;
    const ownerChanged = previousOwnerIdRef.current !== ownerId;
    previousOwnerIdRef.current = ownerId;
    // user 变化 = 一次全新决策,重试额度整体归零;只有 retryNonce 驱动的重跑才
    // 继承计数(否则重试永远数不满,fatal 不可达)。
    if (ownerChanged) {
      retryCountRef.current = 0;
      setDecision({ phase: 'checking' });
    }
    if (!ownerId) {
      return () => {
        cancelled = true;
      };
    }

    (async () => {
     const attemptStartedAt = performance.now();
     // 启动分段打点（2026-09-12）：gate 首次发起 ensureReady 的时刻。若此点远晚于
     // App mount，说明卡点在 AuthContext（dataOwnerId 解析）而非 DB 本身。
     log.info(`gate attempt start uptimeMs=${Math.round(attemptStartedAt)} ownerId=${ownerId ?? 'null'}`);
     try {
      // ensureReady（按 userId 切换 db；失败 main 已弹对话框）
      const ready = await window.electronAPI.localDb.ensureReady(ownerId);
      if (cancelled) return;
      if (!ready.ready) {
        log.error('ensureReady failed', ready.error);
        setDecision({ phase: 'fatal', code: ready.error.code, message: ready.error.message });
        return;
      }
      // 注意：rendererLocalDbReady 的启动信号不在 ensureReady 成功处上报，而是推迟到
      // 下方 cover 撤除（gate ready + 主图 chunks 汇合）时带上 owner 一次性上报，
      // 保证启动器 ready == 界面真实可操作（splash 盖已撤）。

      log.info('startup readiness reached', {
        event: 'renderer.local-db-gate.ready',
        elapsedMs: Math.round(performance.now() - attemptStartedAt),
        rendererUptimeMs: Math.round(performance.now()),
      });

      try {
        const maintenanceResult = await window.electronAPI.localDb.maintenance.getLastResult();
        if (
          maintenanceResult &&
          !shownDbSlimmingResultIds.has(maintenanceResult.id)
        ) {
          shownDbSlimmingResultIds.add(maintenanceResult.id);
          if (maintenanceResult.status === 'completed') {
            toast.success(
              t('settings.about.storage.dbSlimmingToastCompleted', {
                size: formatBytes(maintenanceResult.reclaimedBytes),
              }),
            );
          } else {
            toast.error(
              t(`settings.about.storage.dbSlimmingFailure.${maintenanceResult.reason}`, {
                defaultValue: t('settings.about.storage.dbSlimmingFailure.unknown'),
              }),
            );
          }
        }
      } catch (error) {
        log.warn('database slimming result read failed (non-fatal)', error);
      }

      // Signal main "user logged in + localDb is open" so account integrations can
      // come online after provider discovery. Gated and idempotent in main — re-mounts
      // and account switches are no-ops after the first call.
      // Fire-and-forget: the gate decision below MUST NOT block on bot startup.
      void window.electronAPI.appReadyForBot().catch((err) => {
        log.warn('appReadyForBot signal failed (non-fatal)', err);
      });

      retryCountRef.current = 0;
      setDecision({ phase: 'ready' });
     } catch (err) {
       // ensureReady IPC reject（典型：DbClient 未就绪）不能让 async 异常静默
       // 冒泡、decision 永远停在 'checking' → 永久黑屏。但一次挫折也不能直接
       // fatal(见 MAX_DECISION_RETRIES 注释):先有限重试,耗尽才 fatal。
       if (cancelled) return;
       if (retryCountRef.current < MAX_DECISION_RETRIES) {
         retryCountRef.current += 1;
         log.warn(
           `local-db gate decision failed, retrying (${retryCountRef.current}/${MAX_DECISION_RETRIES})`,
           err,
         );
         retryTimer = setTimeout(() => setRetryNonce((n) => n + 1), DECISION_RETRY_DELAY_MS);
         return;
       }
       log.error('local-db gate decision failed after retries', err);
       setDecision({ phase: 'fatal', message: err instanceof Error ? err.message : String(err) });
     }
    })();

    return () => {
      cancelled = true;
      if (retryTimer !== undefined) clearTimeout(retryTimer);
    };
    // 依赖 user.id——切账号 blank;同账号 refresh 不因对象引用变化卸载 Outlet。
    // retryNonce 驱动失败后的有限重试重跑。
  }, [dataOwnerId, retryNonce, t]);

  useEffect(() => {
    // cover 撤除条件 = gate 决策就绪 且 主图已可渲染（mainChunksReady 汇合，
    // 见上方预加载注释）；fatal 立即显示恢复界面，不受汇合影响。
    const stillCovered =
      !dataOwnerId ||
      decision.phase === 'checking' ||
      (decision.phase === 'ready' && !mainChunksReady);
    if (stillCovered) {
      reportLocalDbGate('pending');
    } else if (decision.phase === 'fatal') {
      reportLocalDbGate('fatal');
    } else {
      reportLocalDbGate('ready');
      // 启动 readiness 终点：splash 盖真实撤除 = 界面可操作。必须带 owner 上报，
      // 否则 local/cloud 模式下主进程 owner 校验会忽略该信号导致启动器永久等待。
      if (!readinessReportedRef.current && dataOwnerId) {
        readinessReportedRef.current = true;
        void window.electronAPI.reportLocalDbReady?.(dataOwnerId).catch(() => {});
      }
    }
    return () => {
      reportLocalDbGate('pending');
    };
  }, [dataOwnerId, decision, mainChunksReady, reportLocalDbGate]);

  if (
    !dataOwnerId ||
    decision.phase === 'checking' ||
    (decision.phase === 'ready' && !mainChunksReady)
  ) {
    // 主界面还不能画。视觉盖由 AppShellCover + Splash / 品牌层承接
    // (DESIGN.md §10),这里返回 null 避免先露出空壳再盖上。
    return null;
  }

  if (decision.phase === 'fatal') {
    // 全屏恢复界面接管：阻断主功能区渲染，并给出「重启并安装更新」等恢复路径。
    return (
      <LocalDbFatalScreen
        code={decision.code}
        message={decision.message}
        onBackToLogin={() => {
          const leave = mode === 'local' ? exitLocalMode() : logout();
          void leave.then(
            () => navigate('/login', { replace: true }),
            (err) => {
              // The fatal screen must always have an escape hatch. A failed
              // teardown is still logged, but must not trap the user here.
              log.warn('failed to leave the current session from local-db fatal screen', err);
              navigate('/login', { replace: true });
            },
          );
        }}
      />
    );
  }

  return <Outlet />;
}
