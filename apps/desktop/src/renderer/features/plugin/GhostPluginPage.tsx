/**
 * Plugin catalog and detail coordinator backed by the latest Ghost host APIs.
 *
 * Inputs: installed Ghost snapshots and user actions. `embedded` mounts the same
 * catalog inside Settings; `onSelectCatalogTab` keeps Plugins / Skills in-panel.
 * Outputs: the Plugin list/detail UI, recommendation-aware return navigation, and Plugin action flows.
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */

import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type KeyboardEvent,
  type ReactNode,
} from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import {
  AlertTriangle,
  ArrowUp,
  Bot,
  Check,
  ChevronDown,
  ChevronRight,
  MessageCircle,
  Plus,
  SlidersHorizontal,
  Sparkles,
  Upload,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { useConfirmDialog } from '@/components/ui/confirm-dialog-provider';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { toast } from '@/lib/toast';
import { extractIpcError } from '@/utils/ipcError';
import { useAuth } from '@/contexts/AuthContext';
import { useInstalledGhosts } from '@/cindy-brain/useInstalledGhosts';
import {
  cancelPendingPluginSuggestion,
  getPendingPluginSuggestion,
  readyPendingPluginSuggestion,
  subscribePendingPluginSuggestion,
} from '@/features/cc-agent/pendingPluginSuggestion';
import { readPluginRecommendationSnapshot } from '@/features/cc-agent/pluginHomeSuggestions';
import { NEW_MAKER_DRAFT_KEY } from '@/features/cc-agent/newMakerDraftKeys';
import {
  getDraft as getComposerDraft,
  plainTextToTiptapDoc,
  saveDraft as saveComposerDraft,
} from '@/lib/composerDraftStore';
import { resetDraftWorkspaceTargets } from '@/state/newMakerDraft';
import { ghostInstallErrorKey } from '@/cindy-brain/installErrorKey';
import { installGhostFromFile, pickAndUpdateGhost } from '@/cindy-brain/installFlow';
import { Spinner } from '@/components/ui/spinner';
import { cn } from '@/lib/utils';
import { AttentionDot } from '@/components/sidebar/AttentionDot';
import {
  useGhostUnread,
  useGhostUnreadEntries,
  useGhostUnreadSummary,
} from '@/cindy-brain/ghostUnreadStore';
import { getLastWorkingDir, subscribeToLastWorkingDir } from '@/state/lastWorkingDir';
import { findSplitChildByPanelKind } from '../../../shared/layoutTree';
import { resolveSystemLocale } from '../../../shared/locale';
import {
  ghostInstallApprovalToken,
  ghostPanelKind,
  isOfficialGhostId,
  type GhostSetupStatus,
  type InstalledGhost,
} from '../../../shared/ghost';
import type {
  PluginMarketDetail,
  PluginMarketInstallOptions,
  PluginMarketItem,
  PluginMarketSnapshot,
} from '../../../shared/pluginMarket';
import type { LegacyGhostRecoveryStatus } from '../../../shared/legacyGhostRecovery';
import {
  toGhostPluginDetail,
  toGhostPluginListItem,
  filterGhostPluginItems,
  ghostWebviewOwnerKey,
  ghostPrimaryAction,
  marketPresentationForInstalledGhost,
  nextOpenPanelIdForOwner,
  sortInstalledForDisplay,
  type GhostPluginListItem,
} from './lib/ghostPluginViewModel';
import { MyPublishesSection } from './MyPublishesSection';
import {
  getUpdateAllBatchState,
  reconcileUpdateAllBatch,
  setUpdateAllBatchHooks,
  subscribeUpdateAllBatch,
} from './lib/updateAllController';
import { formatSetupGateDescription } from './lib/ghostSetupGateModel';
import {
  CatalogSourceSwitcher,
  PLUGIN_MANAGEMENT_CARD_GRID_CLASS,
  PLUGIN_INSTALLED_CARD_GRID_CLASS,
  PluginManagementLayout,
  PluginManagementPage,
} from './PluginManagementLayout';
import { usePluginListScrollRestoration } from './lib/usePluginListScrollRestoration';
import { GhostPagePanelHost } from './GhostPagePanelHost';
import { GhostPluginDetailView } from './GhostPluginDetailView';
import {
  currentMainViewVisibilityOwner,
  readMainViewSidebarVisible,
  useMainViewVisibilityRevision,
  writeMainViewSidebarVisible,
} from '@/cindy-brain/mainViewVisibilityStore';
import { UpdateAllDialog } from './UpdateAllDialog';
import { GhostPluginIcon } from './GhostPluginIcon';
import { MarketPluginDetailView } from './MarketPluginDetailView';
import { PluginScopePicker, usePluginRecentWorkdirs } from './PluginScopePicker';
import {
  canOfferMarketInstall,
  ghostReapprovalRoute,
  marketReviewTargetsInstalledGhost,
  pluginPresentationOrigin,
  pluginUpdateForInstalledVersion,
  type PluginPresentationOrigin,
} from './lib/pluginMarketPresentation';
import { pluginMarketErrorKey } from './lib/pluginMarketErrorKey';
import { usePluginIconRefresh } from './lib/usePluginIconRefresh';
import { usePluginMarketIcon } from './lib/usePluginMarketIcon';
import { usePluginMarketForegroundRefresh } from './lib/usePluginMarketForegroundRefresh';
import { usePluginMarketLocaleRefresh } from './lib/usePluginMarketLocaleRefresh';
import './plugin-motion.css';

/** 旧布局辅助导出仍使用的默认可见数量。 */
const MAX_VISIBLE_INSTALLED_PLUGINS = 8;

type PresentedGhostPluginItem = GhostPluginListItem & {
  origin: PluginPresentationOrigin;
  /** 市场存在更新时的市场记录;列表卡片据此显示更新徽标与直达入口。 */
  marketUpdate: PluginMarketItem | null;
};

/** 折叠入口只预览前三个隐藏插件，避免头像堆叠反过来抢占操作文案。 */
const MAX_COLLAPSED_INSTALLED_PLUGIN_PREVIEWS = 3;

/**
 * 本期隐藏「我的发布」二级 tab，避免与「已安装」争抢顶层布局。
 * 重新开放前必须先定首个 tab 的标签；当前「概览」仅为已被用户否掉的占位词，并非定案。
 */
export const SHOW_MY_PUBLISHES_SECTION = false;

/**
 * Product gate for the whole secondary tab experience. The overview stays mounted while tabs
 * switch, and a disabled gate returns it without an extra wrapper or hidden publishing effects.
 */
export function MyPublishesSectionVisibilityGate({
  visible,
  overviewLabel,
  publishesLabel,
  tabsAriaLabel,
  publishes,
  children,
}: {
  visible: boolean;
  overviewLabel: string;
  publishesLabel: string;
  tabsAriaLabel: string;
  publishes: ReactNode;
  children: ReactNode;
}) {
  const [activeTab, setActiveTab] = useState<'overview' | 'publishes'>('overview');
  const id = useId();
  const overviewTabId = `${id}-overview-tab`;
  const overviewPanelId = `${id}-overview-panel`;
  const publishesTabId = `${id}-publishes-tab`;
  const publishesPanelId = `${id}-publishes-panel`;

  if (!visible) return <>{children}</>;

  return (
    <>
      <div
        role="tablist"
        aria-label={tabsAriaLabel}
        className="mt-5 flex items-end gap-6 border-b border-[var(--border-default)]"
      >
        {([
          ['overview', overviewLabel, overviewTabId, overviewPanelId],
          ['publishes', publishesLabel, publishesTabId, publishesPanelId],
        ] as const).map(([tab, label, tabId, panelId]) => {
          const active = activeTab === tab;
          return (
            <button
              key={tab}
              id={tabId}
              type="button"
              role="tab"
              aria-selected={active}
              aria-controls={panelId}
              onClick={() => setActiveTab(tab)}
              className={cn(
                '-mb-px select-none border-b-2 px-0.5 pb-2.5 pt-1 text-13 font-medium transition-colors',
                'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]',
                active
                  ? 'border-[var(--text-primary)] text-[var(--text-primary)]'
                  : 'border-transparent text-[var(--text-secondary)] hover:text-[var(--text-primary)]',
              )}
            >
              {label}
            </button>
          );
        })}
      </div>
      <div
        id={overviewPanelId}
        role="tabpanel"
        aria-labelledby={overviewTabId}
        hidden={activeTab !== 'overview'}
      >
        {children}
      </div>
      <div
        id={publishesPanelId}
        role="tabpanel"
        aria-labelledby={publishesTabId}
        hidden={activeTab !== 'publishes'}
      >
        {publishes}
      </div>
    </>
  );
}

/** Keeps the installed-section disclosure rule deterministic and directly testable. */
function visibleInstalledPluginItems<T>(items: readonly T[]): T[] {
  return items.slice(0, MAX_VISIBLE_INSTALLED_PLUGINS);
}

function collapsedInstalledPluginPreviewItems<T>(items: readonly T[]): T[] {
  return items.slice(0, MAX_COLLAPSED_INSTALLED_PLUGIN_PREVIEWS);
}

type InstalledPluginPreviewItem = Pick<PresentedGhostPluginItem, 'id' | 'name' | 'iconDataUrl'>;

function InstalledPluginOverflow({
  id,
  expanded,
  children,
}: {
  id: string;
  expanded: boolean;
  children: ReactNode;
}) {
  return (
    <div
      id={id}
      className="plugin-installed-overflow"
      data-expanded={expanded}
      aria-hidden={!expanded}
      inert={!expanded}
    >
      <div className="plugin-installed-overflow-clip">{children}</div>
    </div>
  );
}

function InstalledPluginDisclosure({
  expanded,
  controlsId,
  totalCount,
  previewItems,
  onToggle,
  onIconLoadError,
}: {
  expanded: boolean;
  controlsId: string;
  totalCount: number;
  previewItems: readonly InstalledPluginPreviewItem[];
  onToggle: () => void;
  onIconLoadError?: () => void;
}) {
  const { t } = useTranslation();
  const collapsedPreviewItems = collapsedInstalledPluginPreviewItems(previewItems);

  return (
    <button
      type="button"
      onClick={onToggle}
      aria-expanded={expanded}
      aria-controls={controlsId}
      className="mt-3 inline-flex items-center gap-2.5 rounded-full px-3 py-1.5 text-12 text-[var(--text-secondary)] transition-colors duration-150 hover:bg-[var(--surface-hover-soft)] hover:text-[var(--text-primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]"
    >
      {!expanded ? (
        <span className="plugin-installed-preview-stack" aria-hidden="true">
          {collapsedPreviewItems.map((item, index) => (
            <span
              key={item.id}
              className="plugin-installed-preview-card"
              style={{ zIndex: index + 1 }}
            >
              <GhostPluginIcon
                iconDataUrl={item.iconDataUrl}
                iconId={item.id}
                iconName={item.name}
                onIconLoadError={onIconLoadError}
                size="mini"
              />
            </span>
          ))}
        </span>
      ) : null}
      <span className="inline-flex items-center gap-1.5">
        {t(
          expanded
            ? 'settings.ghosts.page.installedCollapse'
            : 'settings.ghosts.page.installedExpand',
          expanded ? undefined : { count: totalCount },
        )}
        <ChevronDown
          size={13}
          aria-hidden="true"
          className={cn(
            'transition-transform duration-150 motion-reduce:transition-none',
            expanded && 'rotate-180',
          )}
        />
      </span>
    </button>
  );
}

/** Test-only access to the installed-section layout contract. */
export const __installedPluginLayoutForTests = {
  MAX_VISIBLE_INSTALLED_PLUGINS,
  MAX_COLLAPSED_INSTALLED_PLUGIN_PREVIEWS,
  visibleInstalledPluginItems,
  InstalledPluginOverflow,
  InstalledPluginDisclosure,
};

/** 市场首装成功后打开已装详情；更新或来源替换继续停留在当前页面。 */
export function shouldOpenInstalledDetailAfterMarketSuccess(isUpdate: boolean): boolean {
  return !isUpdate;
}

/**
 * Ghost-backed Plugin page.
 *
 * This is the first bridge from the existing Plugin product surface to the
 * real Ghost runtime. The page deliberately keeps the previous list/detail
 * interaction shape, while every displayed field comes from InstalledGhost.
 */
export function GhostPluginPage({
  embedded = false,
  onSelectCatalogTab,
}: {
  embedded?: boolean;
  onSelectCatalogTab?: (tab: 'plugins' | 'skills') => void;
} = {}) {
  const { i18n, t } = useTranslation();
  const marketLocale = resolveSystemLocale(i18n.resolvedLanguage ?? i18n.language);
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const { confirm } = useConfirmDialog();
  const showPluginMarketActionError = useCallback(
    async (error: unknown) => {
      toast.error(t(pluginMarketErrorKey(error)));
    },
    [t],
  );
  const { user, mode, dataOwnerId } = useAuth();
  const [recommendationNonce] = useState(() => searchParams.get('recommendation'));
  const pendingRecommendation = useSyncExternalStore(
    subscribePendingPluginSuggestion,
    getPendingPluginSuggestion,
  );
  const recommendation =
    pendingRecommendation?.nonce === recommendationNonce &&
    pendingRecommendation.ownerId === dataOwnerId
      ? pendingRecommendation
      : null;
  const recommendationPageMounted = useRef(false);
  useEffect(() => {
    recommendationPageMounted.current = true;
    if (getPendingPluginSuggestion()?.ownerId !== dataOwnerId) cancelPendingPluginSuggestion();
    return () => {
      recommendationPageMounted.current = false;
      queueMicrotask(() => {
        if (!recommendationPageMounted.current && getPendingPluginSuggestion()?.phase === 'setup') {
          cancelPendingPluginSuggestion(recommendationNonce ?? undefined);
        }
      });
    };
  }, [dataOwnerId, recommendationNonce]);
  const continueRecommendation = useCallback(
    (nonce: string | undefined, ghostId: string) => {
      if (!recommendationPageMounted.current || !nonce) return false;
      const snapshot = readPluginRecommendationSnapshot();
      if (
        snapshot.ownerId !== dataOwnerId ||
        !snapshot.sources.some((s) => s.ghostId === ghostId && s.enabled)
      )
        return false;
      const ready = readyPendingPluginSuggestion(nonce, dataOwnerId, ghostId);
      if (!ready) return false;
      navigate('/cc-agent/new', { state: { pluginSuggestionNonce: ready }, flushSync: true });
      return true;
    },
    [dataOwnerId, navigate],
  );
  const recommendationNotice = recommendation ? (
    <div
      role="status"
      className="flex shrink-0 items-center justify-between gap-3 border-b border-[var(--border-default)] px-4 py-3 text-13 text-[var(--text-secondary)]"
    >
      <span>
        {t('newChat.pluginSuggestions.pending', { task: recommendation.suggestion.label })}
      </span>
      <button
        type="button"
        className="shrink-0 rounded-full px-2 py-1 hover:bg-[var(--surface-hover)]"
        onClick={() => cancelPendingPluginSuggestion(recommendation.nonce)}
      >
        {t('newChat.pluginSuggestions.cancel')}
      </button>
    </div>
  ) : null;
  const showEnterprise = user?.membershipKind === 'org';
  const ghosts = useInstalledGhosts();
  useMainViewVisibilityRevision();
  const installedGhostMarketKey = useMemo(
    () =>
      ghosts
        .map((ghost) => `${ghost.manifest.id}\0${ghost.manifest.version}`)
        .sort()
        .join('\0'),
    [ghosts],
  );
  const installedGhostLocationsKey = ghosts
    .map((ghost) => `${ghost.manifest.id}\0${ghost.dir}`)
    .sort()
    .join('\0');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [marketSnapshot, setMarketSnapshot] = useState<PluginMarketSnapshot | null>(null);
  const [openPanelId, setOpenPanelId] = useState<string | null>(null);
  // 数据归属键:面板宿主按它失效(定义要早于消费点)。
  const panelOwnerKey = ghostWebviewOwnerKey(mode, dataOwnerId);
  // 当前已安装清单都是应用随带插件，首屏直接落在内置插件。
  const [catalogSource, setCatalogSource] = useState<'external' | 'internal'>('internal');
  const [marketDetail, setMarketDetail] = useState<PluginMarketDetail | null>(null);
  // 列表与详情是互斥分支;列表节点会卸载,返回时需显式恢复进入前的滚动位置。
  const pluginCatalogVisible = marketDetail === null && selectedId === null;
  const {
    listRef: pluginCatalogListRef,
    onListScroll: onPluginCatalogScroll,
    capture: capturePluginCatalogScroll,
    requestRestore: requestPluginCatalogScrollRestore,
    clearPendingRestore: clearPluginCatalogScrollRestore,
  } = usePluginListScrollRestoration(pluginCatalogVisible);
  const [marketBusyId, setMarketBusyId] = useState<string | null>(null);
  // 市场操作的同步互斥锁。React state 在提交前有窗口期,快速连点会让多个回调
  // 都读到 null;ref 先到先得,state 只驱动按钮禁用等 UI 展示。每次占锁都返回
  // 唯一 lease,避免账号/模式切换后的旧异步流程误释放新流程持有的同 pluginId 锁。
  const marketBusyLockRef = useRef<{ pluginId: string } | null>(null);
  const acquireMarketBusy = useCallback((pluginId: string) => {
    if (marketBusyLockRef.current !== null) return null;
    const lease = { pluginId };
    marketBusyLockRef.current = lease;
    setMarketBusyId(pluginId);
    return lease;
  }, []);
  const releaseMarketBusy = useCallback((lease: { pluginId: string }) => {
    if (marketBusyLockRef.current !== lease) return;
    marketBusyLockRef.current = null;
    setMarketBusyId((current) => (current === lease.pluginId ? null : current));
  }, []);
  const isMarketBusyLeaseActive = useCallback(
    (lease: { pluginId: string }) => marketBusyLockRef.current === lease,
    [],
  );
  const marketRefreshRequestRef = useRef(0);
  const lastMarketRefreshAtRef = useRef(0);
  const marketDetailRequestRef = useRef(0);
  const installedGhostMarketKeyRef = useRef(installedGhostMarketKey);
  const legacyRecoveryStatusRequestRef = useRef(0);
  const legacyRecoveryRetryRequestRef = useRef(0);
  const [legacyRecoveryStatus, setLegacyRecoveryStatus] =
    useState<LegacyGhostRecoveryStatus | null>(null);
  const [legacyRecoveryRetrying, setLegacyRecoveryRetrying] = useState(false);
  const refreshMarket = useCallback(async (preserveOnError = false) => {
    const requestId = ++marketRefreshRequestRef.current;
    try {
      const snapshot = await window.electronAPI.pluginMarket.snapshot();
      if (requestId !== marketRefreshRequestRef.current) return;
      // Main intentionally represents market outages as data so the initial page can render a
      // non-blocking empty state. During icon renewal, convert that fulfilled unavailable result
      // back into a failure: the catch path preserves the visible snapshot and the hook retries.
      if (preserveOnError && snapshot.unavailableReason !== null) {
        throw new Error(snapshot.unavailableReason);
      }
      setMarketSnapshot(snapshot);
      lastMarketRefreshAtRef.current = Date.now();
    } catch (error) {
      if (requestId !== marketRefreshRequestRef.current) return;
      setMarketSnapshot((current) =>
        preserveOnError && current
          ? current
          : {
              items: [],
              unavailableReason: error instanceof Error ? error.message : String(error),
              customSourceNames: [],
              unavailableCustomSourceNames: [],
            },
      );
      // Background icon renewal keeps the current snapshot visible, but must still report
      // failure to the renewal hook so it can schedule a bounded retry.
      if (preserveOnError) throw error;
    }
  }, []);
  useEffect(() => {
    clearPluginCatalogScrollRestore();
    setMarketSnapshot(null);
    setMarketDetail(null);
    marketBusyLockRef.current = null;
    setMarketBusyId(null);
    marketDetailRequestRef.current += 1;
    void refreshMarket();
  }, [clearPluginCatalogScrollRestore, refreshMarket, mode, dataOwnerId]);
  const refreshMarketOnForeground = useCallback(() => refreshMarket(true), [refreshMarket]);
  usePluginMarketForegroundRefresh(refreshMarketOnForeground, lastMarketRefreshAtRef);
  useEffect(() => {
    if (installedGhostMarketKeyRef.current === installedGhostMarketKey) return;
    installedGhostMarketKeyRef.current = installedGhostMarketKey;
    // 已装集合或版本变化(装/卸/后台更新)时刷新市场;排序是反应式的。
    void refreshMarket(true).catch(() => undefined);
  }, [installedGhostMarketKey, refreshMarket]);
  const activeSessionWorkingDir = useSyncExternalStore(
    subscribeToLastWorkingDir,
    getLastWorkingDir,
    getLastWorkingDir,
  );
  const recentWorkdirs = usePluginRecentWorkdirs();
  const [scopeDir, setScopeDir] = useState<string | null>(null);
  const scopeDirRef = useRef<string | null>(scopeDir);
  scopeDirRef.current = scopeDir;
  const [projectDisabled, setProjectDisabled] = useState<Set<string>>(() => new Set());
  const handlePickScope = useCallback((dir: string | null) => {
    setScopeDir(dir);
    if (!dir) {
      setProjectDisabled(new Set());
      return;
    }
    try {
      setProjectDisabled(new Set(window.electronAPI.ghosts.workdirPrefsSync(dir).disabled));
    } catch {
      setProjectDisabled(new Set());
    }
  }, []);
  useEffect(() => {
    if (!recommendation) return;
    const target = ghosts.find((g) => g.manifest.id === recommendation.suggestion.pluginId);
    handlePickScope(target?.enabled ? recommendation.workingDir : null);
  }, [recommendation?.nonce, handlePickScope]);
  const effectiveEnabled = useCallback(
    (id: string, globallyEnabled: boolean) =>
      scopeDir === null ? globallyEnabled : globallyEnabled && !projectDisabled.has(id),
    [projectDisabled, scopeDir],
  );
  const [recentGhostIds, setRecentGhostIds] = useState(
    () => window.electronAPI.ghosts.recentUsageSync().ids,
  );
  useEffect(
    () =>
      window.electronAPI.ghosts.onChanged(() => {
        const dir = scopeDirRef.current;
        if (dir) {
          try {
            setProjectDisabled(new Set(window.electronAPI.ghosts.workdirPrefsSync(dir).disabled));
          } catch {
            // Keep the current project snapshot if another window races the read.
          }
        }
      }),
    [],
  );
  useEffect(
    () =>
      window.electronAPI.ghosts.onRecentUsageChanged(({ ids }) => {
        setRecentGhostIds(ids);
      }),
    [],
  );
  useEffect(() => {
    legacyRecoveryStatusRequestRef.current += 1;
    legacyRecoveryRetryRequestRef.current += 1;
    setLegacyRecoveryRetrying(false);
  }, [dataOwnerId, mode]);
  useEffect(() => {
    const requestId = ++legacyRecoveryStatusRequestRef.current;
    if (mode !== 'cloud' || !dataOwnerId) {
      setLegacyRecoveryStatus(null);
      return;
    }
    void window.electronAPI.ghosts
      .legacyRecoveryStatus()
      .then((status) => {
        if (requestId !== legacyRecoveryStatusRequestRef.current) return;
        setLegacyRecoveryStatus(status.state === 'none' ? null : status);
      })
      .catch(() => {
        if (requestId === legacyRecoveryStatusRequestRef.current) {
          setLegacyRecoveryStatus(null);
        }
      });
  }, [dataOwnerId, installedGhostLocationsKey, mode]);
  // /plugins?ghost=<id> 深链:直接打开该插件详情(配置就绪弹窗等入口复用;
  // 读后即清参数,避免从详情返回列表后又被同一参数拉回详情)。
  useEffect(() => {
    const target = searchParams.get('ghost');
    if (!target) return;
    setSelectedId(target);
    const next = new URLSearchParams(searchParams);
    next.delete('ghost');
    setSearchParams(next, { replace: true });
  }, [searchParams, setSearchParams]);
  // /plugins?panel=<id> 深链:打开该插件的页签面板(装入流程「立即开启并
  // 打开面板」从其它视图跳转进来)。合法性由 openPanelGhost 统一裁决:
  // 非 tab 形态或未启用的目标会被下方失效 effect 自动清掉。
  useEffect(() => {
    const target = searchParams.get('panel');
    if (!target) return;
    setOpenPanelId(target);
    const next = new URLSearchParams(searchParams);
    next.delete('panel');
    setSearchParams(next, { replace: true });
  }, [searchParams, setSearchParams]);
  // 引用稳定:批次对账 effect 以它为依赖,裸 `?? []` 每次渲染都是新数组会空转。
  const marketItems = useMemo(() => marketSnapshot?.items ?? [], [marketSnapshot]);
  const marketByGhostId = useMemo(() => {
    const map = new Map<string, PluginMarketItem>();
    for (const item of marketItems) {
      // 非当前路由的同 id 条目只出现在「可替换」市场卡片，
      // 不得投影成已装卡片的普通更新。
      if (item.installState !== 'conflict') map.set(item.ghostId, item);
    }
    return map;
  }, [marketItems]);
  const allInstalledItems = useMemo<PresentedGhostPluginItem[]>(
    () =>
      ghosts
        // cindy-mivo was renamed to xd-mivo. Older user data can still
        // contain both ids; keep the canonical entry from rendering twice.
        .filter(
          (ghost) =>
            ghost.manifest.id !== 'cindy-mivo' ||
            !ghosts.some((candidate) => candidate.manifest.id === 'xd-mivo'),
        )
        .map((ghost) => {
          const marketItem = marketByGhostId.get(ghost.manifest.id) ?? null;
          const presentation = marketPresentationForInstalledGhost(ghost, marketItem);
          return {
            ...toGhostPluginListItem(ghost, presentation),
            origin: pluginPresentationOrigin(marketItem),
            // 同版本展示刷新由 main 标成 installed;legacy-unresolved 仍保留
            // update-available,以便用户用市场包替换未验证的本地字节。
            marketUpdate: pluginUpdateForInstalledVersion(marketItem),
          };
        }),
    [ghosts, marketByGhostId],
  );
  const installedItems = useMemo(
    () => {
      const visibleItems = showEnterprise
        ? allInstalledItems
        : allInstalledItems.filter(
            (item) => item.builtin || item.origin !== 'organization',
          );
      // 当前安装快照均为项目随应用提供的插件；外部插件只从未安装市场项产生。
      return catalogSource === 'internal' ? visibleItems : [];
    },
    [allInstalledItems, catalogSource, showEnterprise],
  );
  const searchedInstalledItems = useMemo(
    () => filterGhostPluginItems(installedItems, query),
    [installedItems, query],
  );
  const handleSelectMarket = useCallback(async (pluginId: string) => {
    const detail = await window.electronAPI.pluginMarket.detail(pluginId).catch(() => null);
    if (detail) setMarketDetail(detail);
  }, []);
  const handleMarketBack = useCallback(() => {
    cancelPendingPluginSuggestion(recommendationNonce ?? undefined);
    requestPluginCatalogScrollRestore();
    marketDetailRequestRef.current += 1;
    setMarketDetail(null);
  }, [recommendationNonce, requestPluginCatalogScrollRestore]);
  // 当前目录中的自带插件直接属于内置插件列表，不显示为外部插件。
  const builtinCatalogItems = useMemo(
    () =>
      catalogSource === 'internal'
        ? marketItems.filter(
            (item) =>
              item.installState !== 'installed' && item.installState !== 'update-available',
          )
        : [],
    [catalogSource, marketItems],
  );

  // ── 已安装区排序:未读通知(新→旧) → 最近使用 → 基础序,实时计算 ──
  // 反应式而非冻结快照:排序信号变化即重排。安全边界——`markUsed` 只在对话里
  // 触发(ChatInput),插件页自身不打点,所以「最近使用」的变化只发生在离开本页
  // 之后,回到页面即已重排,不会在用户眼皮下洗牌;后台到达的未读通知冒头则正是
  // 目的所在。切账号/模式时 recentGhostIds 与未读表都会随 owner 快照整体作废。
  // marketUpdate 刻意不作排序键——更新已有统一横幅兜底,可被折叠。
  const unreadEntries = useGhostUnreadEntries();
  const unreadAtById = useMemo(
    () => new Map(unreadEntries.map((entry) => [entry.ghostId, entry.at])),
    [unreadEntries],
  );
  const displayInstalledItems = useMemo(
    () =>
      sortInstalledForDisplay(searchedInstalledItems, {
        recentIds: recentGhostIds,
        unreadAtById,
      }),
    [searchedInstalledItems, recentGhostIds, unreadAtById],
  );

  // 批次状态住在模块级控制器里(生命周期长于本页:关弹窗离开 /plugins
  // 后批次继续跑),页面只订阅快照。真实包校验与落位由统一安装事务负责。
  const updateBatch = useSyncExternalStore(subscribeUpdateAllBatch, getUpdateAllBatchState);
  const updateRows = updateBatch.rows;
  const batchRunning = updateBatch.running;
  const [updateDialogOpen, setUpdateDialogOpen] = useState(false);
  // 与外部事实对账:已装清单或市场快照变化(单项更新/文件更新/卸载)收束
  // 对应批量行——完成判据取市场快照的 installState(目标 release 是否落账),
  // 不用版本号;账号或模式切换作废整批,旧账号的批次绝不落到新账号数据上。
  useEffect(() => {
    reconcileUpdateAllBatch(marketItems);
  }, [ghosts, marketItems, mode, dataOwnerId]);
  const selectedGhost = selectedId
    ? (ghosts.find((ghost) => ghost.manifest.id === selectedId) ?? null)
    : null;
  const selectedPresentation = selectedGhost
    ? marketPresentationForInstalledGhost(
        selectedGhost,
        marketByGhostId.get(selectedGhost.manifest.id),
      )
    : null;
  const selectedDetail = selectedGhost
    ? toGhostPluginDetail(selectedGhost, selectedPresentation)
    : null;
  const selectedMarketInstall = selectedDetail
    ? (marketByGhostId.get(selectedDetail.id) ?? null)
    : null;
  const selectedMarketUpdate = selectedDetail
    ? pluginUpdateForInstalledVersion(selectedMarketInstall)
    : null;
  const selectedMainViewSidebarVisible = selectedDetail?.hasMainView
    ? readMainViewSidebarVisible(dataOwnerId, selectedDetail.id)
    : true;

  // ── 面板收束:页面独占的插件面板宿主;停用/卸载/换形态自动失效 ──
  const openPanelGhost = useMemo(() => {
    if (!openPanelId) return null;
    const ghost = ghosts.find((candidate) => candidate.manifest.id === openPanelId);
    if (!ghost) return null;
    if (ghost.manifest.panel?.position !== 'tab') return null;
    if (!effectiveEnabled(ghost.manifest.id, ghost.enabled)) return null;
    return ghost;
  }, [effectiveEnabled, ghosts, openPanelId]);
  useEffect(() => {
    if (openPanelId && !openPanelGhost) setOpenPanelId(null);
  }, [openPanelGhost, openPanelId]);
  // 「打开面板 = 已读」不在这里清:三个 setOpenPanelId 调用点(卡片主动作 /
  // 详情页「使用」/ ?panel= 深链)只是"想开",而面板还有停靠态与独立窗口两种
  // 宿主。清零统一收在面板体 GhostChipPanelBody 挂载处——那才是"内容确实在
  // 用户眼前"的唯一判据,三个宿主自然对称。
  /**
   * 账号 / 本地云模式切换必须关掉在开的面板。
   *
   * 光靠上面那条「解析不到就关」不够:两个账号装了**同 id、同版本、同入口**的
   * 插件时,openPanelGhost 在新身份下照样解析得到,面板宿主不会重挂载,于是
   * 账号 A 的 webview DOM、内存态与交互(表单、登录态、已加载数据)原样留在
   * 账号 B 面前。这里按 owner 键显式清空;首帧不清,免得把 ?panel= 深链刚设上的
   * 目标一并抹掉(那条 effect 排在本条之前)。
   */
  const panelOwnerKeyRef = useRef(panelOwnerKey);
  useEffect(() => {
    const previous = panelOwnerKeyRef.current;
    if (previous === panelOwnerKey) return;
    panelOwnerKeyRef.current = panelOwnerKey;
    setOpenPanelId((current) => nextOpenPanelIdForOwner(previous, panelOwnerKey, current));
  }, [panelOwnerKey]);

  const panelStatus = useMemo(() => {
    if (!selectedDetail || selectedDetail.panelMinWidth === null) return null;
    // 页签形态(面板收束):由插件页承载,没有停靠状态可言。
    if (selectedDetail.tabPanel) return t('settings.ghosts.detail.panelPageHosted');
    try {
      const kind = ghostPanelKind(selectedDetail.id);
      const docked =
        findSplitChildByPanelKind(window.electronAPI.layout.getStateSync().layout, kind) !== null;
      return docked
        ? t('settings.ghosts.detail.panelDocked', {
            min: selectedDetail.panelMinWidth,
          })
        : t('settings.ghosts.detail.panelNotDocked');
    } catch {
      return t('settings.ghosts.detail.panelNotDocked');
    }
  }, [selectedDetail, t]);

  const handleToggle = useCallback(
    async (id: string, enabled: boolean, displayName: string) => {
      const pendingNonce = getPendingPluginSuggestion()?.nonce;
      try {
        const dir = scopeDirRef.current;
        if (dir) {
          const result = await window.electronAPI.ghosts.setWorkdirDisabled(dir, id, !enabled);
          setProjectDisabled(new Set(result.disabled));
          toast.success(
            t(
              enabled
                ? 'settings.ghosts.toast.projectEnabled'
                : 'settings.ghosts.toast.projectDisabled',
              { name: displayName },
            ),
          );
        } else {
          await window.electronAPI.ghosts.setEnabled(id, enabled);
        }
        if (enabled) continueRecommendation(pendingNonce, id);
      } catch (error) {
        toast.error(t(ghostInstallErrorKey(extractIpcError(error)?.code)));
      }
    },
    [continueRecommendation, t],
  );

  /** Main 在同一次 install IPC 事务内校验真实包与市场声明的能力上限。 */
  const installMarketPackage = useCallback(
    async (input: {
      pluginId: string;
      options: PluginMarketInstallOptions;
      isStillActive: () => boolean;
    }): Promise<InstalledGhost | null> => {
      const result = await window.electronAPI.pluginMarket.install(input.pluginId, input.options);
      if (!input.isStillActive()) return null;
      return result.ghost;
    },
    [],
  );

  // 目录详情用于发现与能力展示；点击更新后由 Main 下载并校验真实包后直接落位。
  const handleMarketUpdate = useCallback(
    async (ghostId: string) => {
      const marketItem = marketByGhostId.get(ghostId);
      const installedGhost = ghosts.find((ghost) => ghost.manifest.id === ghostId) ?? null;
      if (
        !marketItem ||
        !marketReviewTargetsInstalledGhost(marketItem, installedGhost?.approval.state)
      ) {
        return;
      }
      if (!installedGhost) {
        toast.error(t('settings.ghosts.market.errors.stateChanged'));
        await refreshMarket();
        return;
      }
      // 列表每张卡都有直达入口,同步互斥防止并发更新互相覆盖忙碌状态。
      const marketBusyLease = acquireMarketBusy(marketItem.pluginId);
      if (!marketBusyLease) return;
      try {
        const next = await window.electronAPI.pluginMarket.detail(marketItem.pluginId);
        if (!isMarketBusyLeaseActive(marketBusyLease)) return;
        if (!marketReviewTargetsInstalledGhost(next, installedGhost.approval.state)) {
          toast.error(t('settings.ghosts.market.errors.stateChanged'));
          await refreshMarket();
          return;
        }
        const options: PluginMarketInstallOptions = {
          expectedReleaseId: next.releaseId,
          expectedManifest: next.manifest,
          expectedInstalledApproval: ghostInstallApprovalToken(installedGhost.approval),
          allowSourceReplacement: false,
        };
        const ghost = await installMarketPackage({
          pluginId: next.pluginId,
          options,
          isStillActive: () => isMarketBusyLeaseActive(marketBusyLease),
        });
        if (!ghost || !isMarketBusyLeaseActive(marketBusyLease)) return;
        toast.success(
          t('settings.ghosts.toast.updated', {
            name: ghost.manifest.name,
            version: ghost.manifest.version,
          }),
        );
        // 列表/详情共用此路径:成功后不切页面,方便连续点其它插件的更新。
        await refreshMarket();
      } catch (error) {
        if (isMarketBusyLeaseActive(marketBusyLease)) {
          await showPluginMarketActionError(error);
        }
      } finally {
        releaseMarketBusy(marketBusyLease);
      }
    },
    [
      acquireMarketBusy,
      ghosts,
      isMarketBusyLeaseActive,
      installMarketPackage,
      marketByGhostId,
      refreshMarket,
      releaseMarketBusy,
      showPluginMarketActionError,
      t,
    ],
  );

  const handleUpdate = useCallback(async () => {
    if (!selectedDetail) return;
    if (selectedMarketUpdate) {
      await handleMarketUpdate(selectedDetail.id);
      return;
    }
    await pickAndUpdateGhost(selectedDetail.id, { t });
  }, [handleMarketUpdate, selectedDetail, selectedMarketUpdate, t]);

  /**
   * 安装验证记录缺失或损坏时，用户主动选择重新落位同一来源的真实包。
   * 市场包重装当前 release；本地包重新选择 `.cindy`。两条路都只恢复
   * 完整安装记录，不新增能力确认。
   */
  const handleRecoverInstall = useCallback(
    async (ghostId: string) => {
      if (ghosts.find((ghost) => ghost.manifest.id === ghostId)?.builtin) return;
      if (ghostReapprovalRoute(marketByGhostId.get(ghostId)) === 'market') {
        await handleMarketUpdate(ghostId);
        return;
      }
      await pickAndUpdateGhost(ghostId, { t });
    },
    [ghosts, handleMarketUpdate, marketByGhostId, t],
  );

  const handleUpdateFromFile = useCallback(async () => {
    if (!selectedDetail) return;
    await pickAndUpdateGhost(selectedDetail.id, { t });
  }, [selectedDetail, t]);

  // 控制器在挂载期借用本页的市场刷新。
  useEffect(
    () =>
      setUpdateAllBatchHooks({
        refreshMarket: () => refreshMarket(),
      }),
    [refreshMarket],
  );
  const handlePublish = useCallback(async () => {
    const picked = await window.electronAPI.ghosts.pickFile().catch(() => null);
    if (!picked || 'canceled' in picked) return;
    try {
      await window.electronAPI.pluginPublisher.start(picked.filePath);
    } catch (error) {
      const decoded = extractIpcError(error);
      toast.error(
        decoded?.code === 'PERMISSION_DENIED'
          ? t('settings.ghosts.publish.disabled')
          : t('settings.ghosts.publish.startFailed'),
      );
    }
  }, [t]);

  const handleInstall = useCallback(async () => {
    const picked = await window.electronAPI.ghosts.pickFile().catch(() => null);
    if (!picked || 'canceled' in picked) return;
    await installGhostFromFile(picked.filePath, {
      t,
      // 已在插件页:tab 型插件安装后原地打开面板。
      openPluginPanel: (ghostId) => {
        setSelectedId(null);
        setOpenPanelId(ghostId);
      },
    });
  }, [t]);

  const handleRetryLegacyRecovery = useCallback(async () => {
    legacyRecoveryStatusRequestRef.current += 1;
    const requestId = ++legacyRecoveryRetryRequestRef.current;
    setLegacyRecoveryRetrying(true);
    try {
      const status = await window.electronAPI.ghosts.retryLegacyRecovery();
      if (requestId === legacyRecoveryRetryRequestRef.current) {
        setLegacyRecoveryStatus(status.state === 'none' ? null : status);
      }
    } catch {
      const status = await window.electronAPI.ghosts.legacyRecoveryStatus().catch(() => null);
      if (requestId === legacyRecoveryRetryRequestRef.current) {
        setLegacyRecoveryStatus(status && status.state !== 'none' ? status : null);
      }
    } finally {
      if (requestId === legacyRecoveryRetryRequestRef.current) {
        await refreshMarket().catch(() => undefined);
        if (requestId === legacyRecoveryRetryRequestRef.current) {
          setLegacyRecoveryRetrying(false);
        }
      }
    }
  }, [refreshMarket]);

  const handleCreateWithCindy = useCallback(() => {
    saveComposerDraft(NEW_MAKER_DRAFT_KEY, {
      text: plainTextToTiptapDoc(t('settings.ghosts.page.createPrompt')),
      attachments: [],
      focusAtEnd: true,
    });
    resetDraftWorkspaceTargets();
    navigate('/cc-agent/new');
  }, [navigate, t]);

  // 打开插件详情并滚到「配置」区(就绪弹窗的「去配置」动作)。详情视图
  // 可能尚未挂载,滚动排到渲染之后的下一帧;减弱动效时改即时定位。
  const openGhostConfiguration = useCallback((id: string) => {
    setSelectedId(id);
    const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        document
          .getElementById('ghost-configuration-title')
          ?.scrollIntoView({ behavior: reduceMotion ? 'auto' : 'smooth', block: 'start' });
      });
    });
  }, []);

  const handleUseGhost = useCallback(
    async (id: string, displayName: string) => {
      const ghost = ghosts.find((candidate) => candidate.manifest.id === id);
      if (!ghost) return;
      const opensIOSSimulator = ghost.manifest.iosSimulator === true;
      if (!ghost.manifest.command && !opensIOSSimulator) return;
      const usesHostCapabilityEntry = !ghost.manifest.command && opensIOSSimulator;
      // 使用前置门:点击时现查配置就绪度(main 侧确定性判定),未就绪先
      // 弹窗引导去配置。查询失败不拦——运行期 networkSlot 仍会兜底报错,
      // 这里拦不住只是少了一次前置提醒,不能因此把能用的插件挡在门外。
      let setupStatus: GhostSetupStatus | null = null;
      try {
        setupStatus = await window.electronAPI.ghosts.setupStatus(id);
      } catch {
        setupStatus = null;
      }
      if (setupStatus && !setupStatus.ready) {
        const goConfigure = await confirm({
          title: t('settings.ghosts.setupGate.title', { name: displayName }),
          description: formatSetupGateDescription(setupStatus, t),
          confirmText: t('settings.ghosts.setupGate.configure'),
          cancelText: t('settings.ghosts.setupGate.cancel'),
          // 主操作「去配置」非破坏性,默认焦点落主按钮(弹窗契约的适用场景)。
          autoFocusConfirm: true,
        });
        if (goConfigure) openGhostConfiguration(id);
        return;
      }
      const existing = getComposerDraft(NEW_MAKER_DRAFT_KEY);
      saveComposerDraft(NEW_MAKER_DRAFT_KEY, {
        text: existing?.text ?? null,
        attachments: existing?.attachments ?? [],
        quotes: existing?.quotes ?? [],
        browserComments: existing?.browserComments ?? [],
        ...(ghost.manifest.command ? { pendingGhostId: ghost.manifest.id } : {}),
        ...(usesHostCapabilityEntry ? { pendingHostCapabilityGhostId: ghost.manifest.id } : {}),
        focusAtEnd: existing?.focusAtEnd === true,
      });
      resetDraftWorkspaceTargets();
      navigate('/cc-agent/new');
    },
    [confirm, ghosts, navigate, openGhostConfiguration, t],
  );

  /** 卡片胶囊/详情主动作分发:面板型开页面内面板,指令/Host 能力起对话。 */
  const handlePrimaryAction = useCallback(
    (item: Pick<GhostPluginListItem, 'id' | 'name' | 'tabPanel' | 'canUse' | 'hostCapability'>) => {
      const action = ghostPrimaryAction(item);
      if (action === 'panel') {
        setOpenPanelId(item.id);
        return;
      }
      if (action === 'command' || action === 'capability') {
        void handleUseGhost(item.id, item.name);
        return;
      }
      setSelectedId(item.id);
    },
    [handleUseGhost],
  );

  const handleMainViewSidebarVisibleChange = useCallback(
    (visible: boolean) => {
      const selected = selectedDetail;
      if (!selected?.hasMainView) return;
      const owner = currentMainViewVisibilityOwner();
      void writeMainViewSidebarVisible(owner, selected.id, visible)
        .then((persisted) => {
          if (!persisted) toast.error(t('settings.ghosts.errors.generic'));
        })
        .catch(() => {
          toast.error(t('settings.ghosts.errors.generic'));
        });
    },
    [selectedDetail, t],
  );

  const handleUse = useCallback(() => {
    if (selectedGhost && selectedDetail) {
      handlePrimaryAction(selectedDetail);
    }
  }, [handlePrimaryAction, selectedDetail, selectedGhost]);

  // 导出当前插件的 .cindy 包:main 侧打包安装目录 → 系统保存对话框落盘。
  // 取消选择静默返回;成功/失败都如实 toast。
  const handleExport = useCallback(async () => {
    if (!selectedDetail) return;
    try {
      const result = await window.electronAPI.ghosts.export(selectedDetail.id);
      if (result.status === 'canceled') return;
      toast.success(t('settings.ghosts.toast.exported', { name: selectedDetail.name }));
    } catch {
      toast.error(t('settings.ghosts.toast.exportFailed', { name: selectedDetail.name }));
    }
  }, [selectedDetail, t]);

  const handleUninstall = useCallback(async () => {
    if (!selectedDetail) return;
    const ok = await confirm({
      title: t('settings.ghosts.uninstallConfirm.title', { name: selectedDetail.name }),
      description: t('settings.ghosts.uninstallConfirm.description'),
      confirmText: t('settings.ghosts.uninstall'),
      cancelText: t('settings.ghosts.uninstallConfirm.cancel'),
    });
    if (!ok) return;
    try {
      if (selectedMarketInstall) {
        await window.electronAPI.pluginMarket.uninstall(selectedMarketInstall.pluginId);
        await refreshMarket();
      } else {
        await window.electronAPI.ghosts.uninstall(selectedDetail.id);
      }
      toast.success(t('settings.ghosts.toast.uninstalled', { name: selectedDetail.name }));
    } catch (error) {
      toast.error(
        selectedMarketInstall
          ? t(pluginMarketErrorKey(error))
          : t(ghostInstallErrorKey(extractIpcError(error)?.code)),
      );
    }
  }, [confirm, refreshMarket, selectedDetail, selectedMarketInstall, t]);

  const refreshVisibleMarketDetail = useCallback(async (pluginId: string) => {
    // A background icon renewal may observe navigation, but must never invalidate a
    // user-initiated detail request by advancing its request generation.
    const requestId = marketDetailRequestRef.current;
    try {
      const detail = await window.electronAPI.pluginMarket.detail(pluginId);
      if (requestId !== marketDetailRequestRef.current) return;
      setMarketDetail((current) => (current?.pluginId === pluginId ? detail : current));
    } catch (error) {
      // A background URL renewal must not close an otherwise usable detail page.
      if (requestId === marketDetailRequestRef.current) throw error;
    }
  }, []);
  useEffect(() => {
    const pluginId = searchParams.get('market');
    if (!pluginId) return;
    const next = new URLSearchParams(searchParams);
    next.delete('market');
    setSearchParams(next, { replace: true });
    void handleSelectMarket(pluginId);
  }, [handleSelectMarket, searchParams, setSearchParams]);
  usePluginMarketLocaleRefresh(
    marketLocale,
    async () => {
      await window.electronAPI.setApplicationMenuLocale(marketLocale);
    },
    () => refreshMarket(true),
    marketDetail?.pluginId ? () => refreshVisibleMarketDetail(marketDetail.pluginId) : undefined,
  );
  const visibleMarketIcons = useMemo(
    () => [...marketItems.map((item) => item.icon), marketDetail?.icon],
    [marketDetail?.icon, marketItems],
  );
  const refreshVisibleMarketIcons = useCallback(async () => {
    const refreshes: Promise<void>[] = [refreshMarket(true)];
    if (marketDetail?.pluginId) {
      refreshes.push(refreshVisibleMarketDetail(marketDetail.pluginId));
    }
    await Promise.all(refreshes);
  }, [marketDetail?.pluginId, refreshMarket, refreshVisibleMarketDetail]);
  const handleMarketIconLoadError = usePluginIconRefresh(
    visibleMarketIcons,
    refreshVisibleMarketIcons,
  );

  const runMarketInstallFlow = useCallback(
    async (marketDetailArg: PluginMarketDetail) => {
      const pendingNonce = getPendingPluginSuggestion()?.nonce;
      const marketDetail = marketDetailArg;
      // 确认框等待期间也持有 lease。账号/模式切换会清除当前 lease,
      // 旧确认回调恢复后必须先验权,不能在新会话里继续安装。
      const marketBusyLease = acquireMarketBusy(marketDetail.pluginId);
      if (!marketBusyLease) return;
      // 市场更新与用户显式选择的同 id 替换都走原位更新，
      // 保留生效状态和按 ghostId 存储的用户数据。
      const isUpdate =
        marketDetail.installState === 'update-available' ||
        marketDetail.installState === 'conflict';
      try {
        let installedGhost =
          ghosts.find((ghost) => ghost.manifest.id === marketDetail.ghostId) ?? null;
        if (isUpdate && !installedGhost) {
          try {
            installedGhost =
              window.electronAPI.ghosts
                .listSync()
                .ghosts.find((ghost) => ghost.manifest.id === marketDetail.ghostId) ?? null;
          } catch {
            // bridge 不可用或状态切换时保持 null；下面按状态变化安全终止。
          }
        }
        if (isUpdate && !installedGhost) {
          if (isMarketBusyLeaseActive(marketBusyLease)) {
            toast.error(t('settings.ghosts.market.errors.stateChanged'));
          }
          releaseMarketBusy(marketBusyLease);
          await refreshMarket();
          return;
        }
        if (!isMarketBusyLeaseActive(marketBusyLease)) return;
        const options: PluginMarketInstallOptions = {
          expectedReleaseId: marketDetail.releaseId,
          expectedManifest: marketDetail.manifest,
          ...(isUpdate && installedGhost
            ? { expectedInstalledApproval: ghostInstallApprovalToken(installedGhost.approval) }
            : {}),
          // 来源隔离(#2043):仅用户显式选择的冲突替换允许切换来源;更新与原位安装不切换。
          allowSourceReplacement: marketDetail.installState === 'conflict',
        };
        const ghost = await installMarketPackage({
          pluginId: marketDetail.pluginId,
          options,
          isStillActive: () => isMarketBusyLeaseActive(marketBusyLease),
        });
        if (!ghost || !isMarketBusyLeaseActive(marketBusyLease)) return;
        if (continueRecommendation(pendingNonce, ghost.manifest.id)) return;
        // 市场首装装完即开(2026-07-26 定案),toast 用"已安装";更新路径如实
        // 用"已更新"(生效状态未被改变),并留在当前页方便连续更新多个插件。
        toast.success(
          isUpdate
            ? t('settings.ghosts.toast.updated', {
                name: ghost.manifest.name,
                version: ghost.manifest.version,
              })
            : t('settings.ghosts.toast.installed', {
                name: ghost.manifest.name,
              }),
        );
        if (shouldOpenInstalledDetailAfterMarketSuccess(isUpdate)) {
          setMarketDetail((current) =>
            current?.pluginId === marketDetail.pluginId ? null : current,
          );
          setSelectedId(ghost.manifest.id);
        } else {
          await refreshVisibleMarketDetail(marketDetail.pluginId).catch(() => undefined);
        }
        await refreshMarket();
      } catch (error) {
        if (isMarketBusyLeaseActive(marketBusyLease)) {
          await showPluginMarketActionError(error);
        }
      } finally {
        releaseMarketBusy(marketBusyLease);
      }
    },
    [
      acquireMarketBusy,
      ghosts,
      isMarketBusyLeaseActive,
      installMarketPackage,
      continueRecommendation,
      refreshMarket,
      refreshVisibleMarketDetail,
      releaseMarketBusy,
      showPluginMarketActionError,
      t,
    ],
  );
  const handleInstallFromMarket = useCallback(async () => {
    if (!marketDetail) return;
    await runMarketInstallFlow(marketDetail);
  }, [marketDetail, runMarketInstallFlow]);
  // 面板收束:aside 只挂在插件页语境里(列表/详情/市场详情共用),
  // 路由离开本页组件整体卸载 → webview 一并回收,绝不残留到别的界面。
  const panelAside = openPanelGhost ? (
    // key 纳入 owner 代际:双保险。即便将来某条路径漏了上面的清空,换身份也会
    // 强制卸载重建宿主(webview 连同它的 DOM/内存态一起丢),不会跨账号复用。
    <GhostPagePanelHost
      key={`${panelOwnerKey}:${openPanelGhost.manifest.id}`}
      ghost={openPanelGhost}
      onClose={() => setOpenPanelId(null)}
    />
  ) : null;

  if (marketDetail) {
    return (
      <div className="flex h-full min-h-0 w-full">
        <div className="flex min-w-0 flex-1 flex-col">
          {recommendationNotice}
          <div className="min-h-0 flex-1">
            <MarketPluginDetailView
              detail={marketDetail}
              busy={marketBusyId === marketDetail.pluginId}
              onBack={handleMarketBack}
              onInstall={
                canOfferMarketInstall(mode, marketDetail.ghostId)
                  ? () => void handleInstallFromMarket()
                  : undefined
              }
              onIconLoadError={handleMarketIconLoadError}
            />
          </div>
        </div>
        {panelAside}
      </div>
    );
  }

  if (selectedDetail) {
    return (
      <div className="flex h-full min-h-0 w-full">
        <div className="flex min-w-0 flex-1 flex-col">
          {recommendationNotice}
          <div className="min-h-0 flex-1">
            <GhostPluginDetailView
              ghost={selectedGhost}
              detail={selectedDetail}
              panelStatus={panelStatus}
              enabledOverride={
                selectedGhost
                  ? effectiveEnabled(selectedGhost.manifest.id, selectedGhost.enabled)
                  : undefined
              }
              onBack={() => {
                cancelPendingPluginSuggestion(recommendationNonce ?? undefined);
                setSelectedId(null);
              }}
              onToggle={(enabled) =>
                void handleToggle(selectedDetail.id, enabled, selectedDetail.name)
              }
              onUse={handleUse}
              mainViewSidebarVisible={selectedMainViewSidebarVisible}
              onMainViewSidebarVisibleChange={handleMainViewSidebarVisibleChange}
              onUpdate={() => void handleUpdate()}
              onUpdateFromFile={() => void handleUpdateFromFile()}
              onReapprove={() => void handleRecoverInstall(selectedDetail.id)}
              updateVersion={selectedMarketUpdate?.version}
              updateBusy={(selectedMarketUpdate !== null && marketBusyId !== null) || batchRunning}
              onUninstall={() => void handleUninstall()}
              // 官方保留前缀(cindy-/filo-/xd-)的插件走本地装入会被拒,
              // 导出产物无法重装,不提供导出项。
              onExport={
                selectedGhost && !isOfficialGhostId(selectedDetail.id)
                  ? () => void handleExport()
                  : undefined
              }
              toggleDisabled={scopeDir !== null && selectedGhost !== null && !selectedGhost.enabled}
              onIconLoadError={handleMarketIconLoadError}
            />
          </div>
        </div>
        {panelAside}
      </div>
    );
  }

  return (
    <PluginManagementLayout
      activeTab="plugins"
      query={query}
      onQueryChange={setQuery}
      searchPlaceholder={t('settings.ghosts.page.search')}
      clearSearchLabel={t('settings.ghosts.page.clearSearch')}
      embedded={embedded}
      onSelectTab={onSelectCatalogTab}
      headerActions={
        <GhostPluginActions
          onInstall={() => void handleInstall()}
          onCreateWithCindy={handleCreateWithCindy}
        />
      }
    >
      <div className="flex min-h-0 flex-1">
        <main
          ref={pluginCatalogListRef}
          className={cn(
            'min-h-0 w-full min-w-0 flex-1 overflow-y-auto [scrollbar-gutter:stable_both-edges]',
            embedded ? 'bg-transparent' : 'bg-[var(--surface)]',
          )}
          onScroll={onPluginCatalogScroll}
        >
          <PluginManagementPage>
            {recommendationNotice}
            <header className="plugin-motion-page-header pb-2">
              <div className="min-w-0">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <h1 className="text-28 font-medium leading-tight text-[var(--text-primary)]">
                    {t('settings.ghosts.title')}
                  </h1>
                  <PluginScopePicker
                    scopeDir={scopeDir}
                    activeSessionWorkingDir={activeSessionWorkingDir ?? undefined}
                    recentWorkdirs={recentWorkdirs}
                    onPick={handlePickScope}
                  />
                </div>
                <p className="mt-2 max-w-2xl text-14 leading-6 text-[var(--text-secondary)]">
                  {t('settings.ghosts.description')}
                </p>
              </div>
            </header>

            <CatalogSourceSwitcher
              activeSource={catalogSource}
              externalLabel={t('settings.ghosts.page.externalTab')}
              internalLabel={t('settings.ghosts.page.internalTab')}
              ariaLabel={t('settings.ghosts.page.sourceTabsAria')}
              onChange={setCatalogSource}
            />

            <MyPublishesSectionVisibilityGate
              visible={SHOW_MY_PUBLISHES_SECTION && showEnterprise}
              overviewLabel={t('settings.ghosts.page.overviewTab')}
              publishesLabel={t('settings.ghosts.publish.section')}
              tabsAriaLabel={t('settings.ghosts.page.secondaryTabsAria')}
              publishes={
                <MyPublishesSection
                  enabled={showEnterprise}
                  onPublish={() => void handlePublish()}
                />
              }
            >
            {scopeDir ? (
              <div className="mt-5 flex items-center justify-between gap-3 rounded-xl border border-[var(--border-default)] bg-[var(--surface-chip)] px-4 py-3">
                <div className="flex min-w-0 items-center gap-2.5">
                  <span className="truncate text-13 font-medium text-[var(--text-primary)]">
                    {scopeDir}
                  </span>
                  <span className="truncate text-12 text-[var(--text-tertiary)]">
                    {t('settings.ghosts.projectBanner.desc')}
                  </span>
                </div>
                <button
                  type="button"
                  onClick={() => handlePickScope(null)}
                  className="shrink-0 rounded-full border border-[var(--border-default)] px-3 py-1 text-12 text-[var(--text-secondary)] transition-colors hover:bg-[var(--surface-hover-soft)]"
                >
                  {t('settings.ghosts.projectBanner.backToGlobal')}
                </button>
              </div>
            ) : null}

            <section className="plugin-motion-page-section mt-6 min-w-0">
              {legacyRecoveryStatus ? (
                <LegacyGhostRecoveryNotice
                  status={legacyRecoveryStatus}
                  retrying={legacyRecoveryRetrying}
                  onRetry={() => void handleRetryLegacyRecovery()}
                />
              ) : null}


              {displayInstalledItems.length > 0 ? (
                <div className={cn('plugin-motion-stagger', PLUGIN_INSTALLED_CARD_GRID_CLASS)}>
                  {displayInstalledItems.map((item) => (
                    <GhostPluginCard
                      key={item.id}
                      item={item}
                      sourceLabel={t(`settings.ghosts.page.origin.${item.origin}`)}
                      updateVersion={item.marketUpdate?.version}
                      updateBusy={
                        (item.marketUpdate !== null && marketBusyId !== null) || batchRunning
                      }
                      updatePending={item.marketUpdate?.pluginId === marketBusyId}
                      onUpdate={
                        item.marketUpdate ? () => void handleMarketUpdate(item.id) : undefined
                      }
                      effectiveEnabled={effectiveEnabled(item.id, item.enabled)}
                      onPrimary={() => handlePrimaryAction(item)}
                      onManage={() => setSelectedId(item.id)}
                      onIconLoadError={handleMarketIconLoadError}
                    />
                  ))}
                </div>
              ) : null}
              {builtinCatalogItems.length > 0 ? (
                <div className={cn('plugin-motion-stagger mt-4', PLUGIN_MANAGEMENT_CARD_GRID_CLASS)}>
                  {builtinCatalogItems.map((item) => (
                    <MarketPluginCard
                      key={item.pluginId}
                      item={item}
                      busy={marketBusyId !== null}
                      pending={marketBusyId === item.pluginId}
                      onSelect={() => void handleSelectMarket(item.pluginId)}
                      onInstall={undefined}
                      onIconLoadError={handleMarketIconLoadError}
                    />
                  ))}
                </div>
              ) : null}
            </section>

            </MyPublishesSectionVisibilityGate>
          </PluginManagementPage>
        </main>
        {panelAside}
      </div>
      {updateRows ? (
        <UpdateAllDialog
          open={updateDialogOpen}
          rows={updateRows}
          iconByGhostId={new Map(ghosts.map((ghost) => [ghost.manifest.id, ghost.iconDataUrl]))}
          onClose={() => setUpdateDialogOpen(false)}
        />
      ) : null}
    </PluginManagementLayout>
  );
}

export function LegacyGhostRecoveryNotice({
  status,
  retrying,
  onRetry,
}: {
  status: LegacyGhostRecoveryStatus;
  retrying: boolean;
  onRetry: () => void;
}) {
  const { t } = useTranslation();
  if (status.state === 'none') return null;
  const messageKey =
    status.state === 'claimed-by-other-owner'
      ? 'settings.ghosts.legacyRecovery.claimedByOtherOwner'
      : status.state === 'partial' || status.canRetry
        ? status.canRetry
          ? 'settings.ghosts.legacyRecovery.partial'
          : 'settings.ghosts.legacyRecovery.partialBlocked'
        : 'settings.ghosts.legacyRecovery.deferred';
  return (
    <div className="rounded-xl border-[0.5px] border-[var(--border-default)] bg-[var(--surface-elevated)] px-5 py-6 text-left">
      <p className="text-14 font-medium text-[var(--text-primary)]">
        {t('settings.ghosts.legacyRecovery.title')}
      </p>
      <p className="mt-2 text-13 leading-5 text-[var(--text-secondary)]">
        {t(messageKey, { count: status.legacyPluginCount })}
      </p>
      {status.canRetry ? (
        <button
          type="button"
          onClick={onRetry}
          disabled={retrying}
          className={cn(
            'mt-4 inline-flex h-9 items-center rounded-full border border-[var(--border-default)] px-4 text-12 font-medium text-[var(--text-primary)]',
            'transition-[background-color,border-color,opacity,transform] duration-150 hover:bg-[var(--surface-hover-soft)] active:scale-[0.98]',
            'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)] disabled:cursor-wait disabled:opacity-55 disabled:active:scale-100',
          )}
        >
          {retrying
            ? t('settings.ghosts.legacyRecovery.retrying')
            : t('settings.ghosts.legacyRecovery.retry')}
        </button>
      ) : null}
    </div>
  );
}

export function MarketPluginCard({
  item,
  busy,
  pending = false,
  onSelect,
  onInstall,
  onIconLoadError,
}: {
  item: PluginMarketItem;
  busy: boolean;
  /** 本卡正在安装:主按钮换成 Spinner。 */
  pending?: boolean;
  onSelect: () => void;
  /** 卡片直接安装；卡片正文、右侧空白与右上角箭头都进入详情。 */
  onInstall?: () => void;
  onIconLoadError: () => void;
}) {
  const { t } = useTranslation();
  const marketIcon = usePluginMarketIcon(item, { deferUntilVisible: true });
  const unavailable = busy;
  const replacementDescriptionId = useId();
  const replacementDescription =
    item.installState === 'conflict' ? t('settings.ghosts.market.replaceDescription') : undefined;
  return (
    <article
      className={cn(
        'group flex min-h-[108px] w-full select-none items-start gap-4 rounded-xl border-[0.5px] border-[var(--border-default)] bg-[var(--surface-elevated)] p-4 text-left',
        'transition-[background-color,border-color,transform] duration-150 ease-out',
        'hover:-translate-y-px hover:border-[var(--text-tertiary)] hover:bg-[var(--surface-hover-soft)]',
        'active:translate-y-0 active:scale-[0.992] motion-reduce:transform-none motion-reduce:transition-none',
      )}
    >
      <button
        type="button"
        onClick={onSelect}
        disabled={unavailable}
        aria-label={item.name}
        aria-describedby={replacementDescription ? replacementDescriptionId : undefined}
        className={cn(
          'flex min-w-0 flex-1 items-start gap-4 self-stretch text-left',
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]',
          unavailable ? 'cursor-wait' : 'cursor-pointer',
        )}
      >
        <GhostPluginIcon
          iconContainerRef={marketIcon.containerRef}
          iconDataUrl={marketIcon.iconDataUrl}
          iconId={item.ghostId}
          iconName={item.name}
          onIconLoad={marketIcon.onIconLoad}
          onIconLoadError={() => marketIcon.onIconLoadError(onIconLoadError)}
        />
        <span className="flex min-w-0 flex-1 flex-col self-stretch pt-0.5">
          <span className="truncate text-15 font-medium text-[var(--text-primary)]">
            {item.name}
          </span>
          <span className="mt-1 flex min-w-0 items-center gap-1.5 overflow-hidden whitespace-nowrap text-11 text-[var(--text-tertiary)]">
            <span className="shrink-0">
              {t(`settings.ghosts.page.origin.${pluginPresentationOrigin(item)}`)}
            </span>
            <span className="shrink-0" aria-hidden="true">
              ·
            </span>
            <span className="shrink-0">v{item.version}</span>
            <span className="shrink-0" aria-hidden="true">
              ·
            </span>
            <span className="min-w-0 truncate font-mono">{item.ghostId}</span>
            {item.author ? (
              <>
                <span className="shrink-0" aria-hidden="true">
                  ·
                </span>
                <span className="min-w-0 truncate">{item.author}</span>
              </>
            ) : null}
          </span>
          <span
            id={replacementDescription ? replacementDescriptionId : undefined}
            className="mt-1.5 line-clamp-2 text-13 leading-5 text-[var(--text-secondary)]"
          >
            {replacementDescription ?? (item.description || item.ghostId)}
          </span>
        </span>
      </button>
      <div className="relative flex min-h-[76px] min-w-8 shrink-0 flex-col items-end justify-end self-stretch">
        <button
          type="button"
          onClick={onSelect}
          disabled={unavailable}
          aria-label={t('settings.ghosts.market.detailsAria', { name: item.name })}
          aria-describedby={replacementDescription ? replacementDescriptionId : undefined}
          className={cn(
            'group/market-details absolute inset-0 flex items-start justify-end rounded-xl text-[var(--text-tertiary)]',
            'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)] disabled:cursor-not-allowed disabled:opacity-40',
          )}
        >
          <span
            className={cn(
              'grid size-8 shrink-0 place-items-center rounded-full',
              'transition-[background-color,color,transform] duration-150 group-hover/market-details:bg-[var(--surface-hover-soft)] group-hover/market-details:text-[var(--text-primary)] group-active/market-details:scale-[0.96]',
            )}
          >
            <ChevronRight size={16} aria-hidden="true" />
          </span>
        </button>
        {onInstall ? (
          <button
            type="button"
            onClick={(event) => {
              event.stopPropagation();
              onInstall();
            }}
            disabled={unavailable}
            aria-busy={pending || undefined}
            aria-label={
              item.installState === 'conflict'
                ? t('settings.ghosts.market.replaceAria', { name: item.name })
                : t('settings.ghosts.page.installAria', { name: item.name })
            }
            aria-describedby={replacementDescription ? replacementDescriptionId : undefined}
            className={cn(
              'relative z-[1] inline-flex h-8 min-w-[72px] shrink-0 items-center justify-center rounded-full border border-[var(--border-default)] bg-[var(--surface-elevated)] px-3.5 text-12 font-medium text-[var(--text-primary)]',
              'transition-[background-color,border-color,transform,opacity] duration-150 hover:bg-[var(--surface-hover-soft)] active:scale-[0.98]',
              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)] disabled:cursor-not-allowed disabled:opacity-40',
            )}
          >
            {pending ? (
              <Spinner size={14} />
            ) : (
              t(
                item.installState === 'conflict'
                  ? 'settings.ghosts.market.replace'
                  : 'settings.ghosts.market.install',
              )
            )}
          </button>
        ) : null}
      </div>
    </article>
  );
}

/** Plugin-specific creation and import actions rendered after the shared search. */
function GhostPluginActions({
  onInstall,
  onCreateWithCindy,
}: {
  onInstall: () => void;
  onCreateWithCindy: () => void;
}) {
  const { t } = useTranslation();

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className={cn(
            'plugin-management-action-trigger group inline-flex h-9 shrink-0 items-center gap-2 rounded-full border border-[var(--border-default)]',
            'bg-[var(--surface-elevated)] px-3.5 text-12 font-medium text-[var(--text-primary)] shadow-[var(--plugin-card-shadow)]',
            'transition-[background-color,border-color,transform] duration-150 ease-out',
            'hover:border-[var(--text-tertiary)] hover:bg-[var(--surface-hover-soft)] active:scale-[0.98]',
            'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]',
            'data-[state=open]:border-[var(--text-tertiary)] data-[state=open]:bg-[var(--surface-chip)]',
          )}
          aria-label={t('settings.ghosts.page.addPluginAria')}
        >
          <Plus size={14} strokeWidth={1.8} aria-hidden="true" />
          <span className="plugin-management-action-label">
            {t('settings.ghosts.page.addPlugin')}
          </span>
          <ChevronDown
            size={13}
            strokeWidth={1.75}
            className="plugin-management-action-chevron transition-transform duration-150 group-data-[state=open]:rotate-180 motion-reduce:transition-none"
            aria-hidden="true"
          />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="end"
        sideOffset={8}
        className="w-max min-w-52 max-w-[calc(100vw-2rem)] rounded-[12px] border-[0.5px] border-[var(--border-default)] bg-[var(--surface-elevated)] p-1.5 text-[var(--text-primary)] shadow-[var(--shadow-menu)]"
      >
        <DropdownMenuItem
          onSelect={onCreateWithCindy}
          className="h-10 gap-3 whitespace-nowrap rounded-lg px-3 text-13 focus:bg-[var(--surface-hover-soft)] focus:text-[var(--text-primary)]"
        >
          <Sparkles
            size={16}
            strokeWidth={1.7}
            className="text-[var(--text-secondary)]"
            aria-hidden="true"
          />
          {t('settings.ghosts.page.createWithCindy')}
        </DropdownMenuItem>
        <DropdownMenuSeparator className="mx-2 my-1 h-px bg-[var(--border-default)]" />
        <DropdownMenuItem
          onSelect={onInstall}
          className="h-10 gap-3 whitespace-nowrap rounded-lg px-3 text-13 focus:bg-[var(--surface-hover-soft)] focus:text-[var(--text-primary)]"
        >
          <Upload
            size={16}
            strokeWidth={1.7}
            className="text-[var(--text-secondary)]"
            aria-hidden="true"
          />
          {t('settings.ghosts.install')}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/**
 * 已安装插件卡片(设计定稿):
 * - 整卡可点 = 进详情(与滑杆管理入口同目标);
 * - 主动作留在右下角胶囊(面板「使用」/ 指令或能力「对话」/ 工具型无按钮);
 * - 无启用开关(收进详情页);滑杆图标 = 管理入口;
 * - 更新 = 文字胶囊「更新到 vX」,无任何小圆点(绿点专职未读语义,PR-B 接入)。
 */
export function GhostPluginCard({
  item,
  sourceLabel,
  updateVersion,
  updateBusy = false,
  updatePending = false,
  onUpdate,
  effectiveEnabled,
  onPrimary,
  onManage,
  onIconLoadError,
}: {
  item: GhostPluginListItem;
  sourceLabel?: string;
  /** 市场存在新版本时的目标版本;与 onUpdate 同时提供。 */
  updateVersion?: string;
  updateBusy?: boolean;
  /** 本卡正在更新:更新胶囊换成 Spinner。 */
  updatePending?: boolean;
  onUpdate?: () => void;
  effectiveEnabled?: boolean;
  onPrimary: () => void;
  onManage: () => void;
  onIconLoadError?: () => void;
}) {
  const { t } = useTranslation();
  const enabled = effectiveEnabled ?? item.enabled;
  // 未读(badge 槽):单条卡片走**呼吸**点(AttentionDot 形态规范——聚合入口
  // 静态、单条呼吸)。有摘要时顶替静态描述:用户扫一眼就知道新内容是什么。
  const unread = useGhostUnread(item.id);
  const unreadSummary = useGhostUnreadSummary(item.id);
  const primary = ghostPrimaryAction(item);
  const handleCardKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (event.target !== event.currentTarget) return;
    if (event.key !== 'Enter' && event.key !== ' ') return;
    event.preventDefault();
    onManage();
  };
  let primaryControl: ReactNode;
  if (!enabled) {
    primaryControl = (
      <CardPillButton onClick={onManage} label={t('settings.ghosts.page.manageAction')} />
    );
  } else if (primary === 'panel') {
    primaryControl = (
      <CardPillButton
        onClick={onPrimary}
        label={t('settings.ghosts.page.usePanelAction')}
        ariaLabel={t('settings.ghosts.page.useAria', { name: item.name })}
      />
    );
  } else if (primary === 'command' || primary === 'capability') {
    primaryControl = (
      <CardPillButton
        onClick={onPrimary}
        icon={<MessageCircle size={13} aria-hidden="true" />}
        label={t('settings.ghosts.page.chatAction')}
        ariaLabel={t('settings.ghosts.page.chatAria', { name: item.name })}
      />
    );
  } else {
    primaryControl = (
      <span className="flex items-center gap-1.5 whitespace-nowrap text-11 text-[var(--text-tertiary)]">
        <Bot size={13} aria-hidden="true" />
        {t('settings.ghosts.page.agentInvoked')}
      </span>
    );
  }
  return (
    <article
      role="button"
      tabIndex={0}
      onClick={onManage}
      onKeyDown={handleCardKeyDown}
      aria-label={item.name}
      className={cn(
        'group flex min-h-[108px] w-full cursor-pointer select-none items-start gap-4 rounded-xl border-[0.5px] border-[var(--border-default)] bg-[var(--surface-elevated)] p-4 text-left',
        'transition-[background-color,border-color,transform] duration-150 ease-out',
        'hover:-translate-y-px hover:border-[var(--text-tertiary)] hover:bg-[var(--surface-hover-soft)]',
        'active:translate-y-0 active:scale-[0.992]',
        'motion-reduce:transform-none motion-reduce:transition-none',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]',
        !enabled && 'opacity-60',
      )}
    >
      <GhostPluginIcon
        iconDataUrl={item.iconDataUrl}
        iconId={item.id}
        iconName={item.name}
        onIconLoadError={onIconLoadError}
      />
      <span className="flex min-w-0 flex-1 flex-col self-stretch pt-0.5">
        <span className="flex min-w-0 items-center gap-1.5">
          <span className="truncate text-15 font-medium text-[var(--text-primary)]">
            {item.name}
          </span>
          {unread ? <AttentionDot breathing size={6} className="mt-px" /> : null}
        </span>
        <span className="mt-1 block min-w-0 truncate text-11 text-[var(--text-tertiary)]">
          {sourceLabel ? `${sourceLabel} · ` : ''}v{item.version}
          {item.oauthAuthorizationExpired ? (
            <span className="inline-flex items-center gap-1 text-[var(--warning-fg)]">
              {' · '}
              <AlertTriangle size={11} className="inline" aria-hidden="true" />
              <span>{t('settings.ghosts.page.oauthAuthorizationExpired')}</span>
            </span>
          ) : !updateVersion ? (
            <span className="inline-flex items-center gap-1">
              {' · '}
              <Check size={11} className="inline" aria-hidden="true" />
              {t('settings.ghosts.page.upToDate')}
            </span>
          ) : null}
          {!enabled ? ` · ${t('settings.ghosts.disabledTag')}` : ''}
        </span>
        {/* 未读摘要顶替静态描述:静态描述用户早读过了,"新内容是什么"才是这一刻
            的信息。摘要文字提到 primary 档以区别于常态描述(不另加色,颜色语义
            留给那颗点)。 */}
        <span
          className={cn(
            'mt-1.5 line-clamp-2 text-13 leading-5',
            unreadSummary ? 'text-[var(--text-primary)]' : 'text-[var(--text-secondary)]',
          )}
        >
          {unreadSummary || item.description || item.id}
        </span>
      </span>
      {/* 右列只在真实控件上拦截冒泡;空白与「由 Agent 调用」提示仍走整卡进详情。 */}
      <span className="flex shrink-0 flex-col items-end justify-between gap-2 self-stretch">
        <span className="flex items-center gap-1.5">
          {updateVersion && onUpdate ? (
            <button
              type="button"
              onClick={stopAnd(onUpdate)}
              disabled={updateBusy}
              aria-busy={updatePending || undefined}
              aria-label={t('settings.ghosts.page.updateAria', {
                name: item.name,
                version: updateVersion,
              })}
              className={cn(
                'inline-flex h-7 min-w-[72px] items-center justify-center gap-1 rounded-full border border-[var(--border-default)] bg-[var(--surface-elevated)] px-2.5 text-11 font-medium text-[var(--text-primary)]',
                'transition-colors duration-150 hover:bg-[var(--surface-hover-soft)]',
                'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]',
                'disabled:cursor-wait disabled:opacity-40',
              )}
            >
              {updatePending ? (
                <Spinner size={12} />
              ) : (
                <>
                  <ArrowUp size={11} className="text-[var(--text-secondary)]" aria-hidden="true" />
                  {t('settings.ghosts.page.updateTo', { version: updateVersion })}
                </>
              )}
            </button>
          ) : null}
          <button
            type="button"
            onClick={stopAnd(onManage)}
            aria-label={t('settings.ghosts.page.manageAria', { name: item.name })}
            title={t('settings.ghosts.page.manageAction')}
            className="grid size-7 place-items-center rounded-full text-[var(--text-tertiary)] transition-colors duration-150 hover:bg-[var(--surface-hover-soft)] hover:text-[var(--text-primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]"
          >
            <SlidersHorizontal size={14} aria-hidden="true" />
          </button>
        </span>
        {primaryControl}
      </span>
    </article>
  );
}

function stopAnd(handler: () => void) {
  return (event: { stopPropagation: () => void }) => {
    event.stopPropagation();
    handler();
  };
}

function CardPillButton({
  onClick,
  label,
  icon,
  ariaLabel,
}: {
  onClick: () => void;
  label: string;
  icon?: ReactNode;
  ariaLabel?: string;
}) {
  return (
    <button
      type="button"
      onClick={stopAnd(onClick)}
      aria-label={ariaLabel ?? label}
      className={cn(
        'inline-flex h-8 shrink-0 items-center justify-center gap-1.5 rounded-full bg-[var(--surface-chip)] px-3.5 text-12 font-medium text-[var(--text-primary)]',
        'transition-[background-color,transform] duration-150 hover:bg-[var(--surface-hover)] active:scale-[0.98]',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]',
      )}
    >
      {icon}
      {label}
    </button>
  );
}
