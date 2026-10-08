import {
  Suspense,
  lazy,
  type ComponentType,
  type LazyExoticComponent,
  type ReactElement,
  type ReactNode,
} from 'react';
import { createHashRouter, Navigate } from 'react-router-dom';

import { RouteErrorFallback } from '@/components/error/RouteErrorFallback';
import { LoginPage } from '@/components/login/LoginPage';
import { AddAccountLoginPage } from '@/components/login/AddAccountLoginPage';
import { ProtectedRoute } from '@/components/auth/ProtectedRoute';
import { GuestRoute } from '@/components/auth/GuestRoute';
import { LocalDbGate } from '@/components/auth/LocalDbGate';

/**
 * 路由级懒加载（2026-09-12 启动提速「App 模块拆分」）。
 *
 * 背景：此前本文件静态 import 全部 feature（cc-agent/settings/skillhub/bots/
 * scheduler… 20+ 个大图），导致 `import('./App')` 的模块图在 gate ready 前就
 * 把整个主功能区加载完——boot-timing 打点实测 App 图约 13s，其中绝大多数是
 * gate 前根本不会渲染的模块。
 *
 * 拆分原则：
 *  - 保持静态：gate 链（ProtectedRoute/GuestRoute/LocalDbGate）、登录线
 *    （LoginPage/AddAccountLoginPage）、错误兜底（RouteErrorFallback）——它们
 *    在 gate ready 前可能被渲染；
 *  - 懒加载：主功能区全部（MainLayout 及所有 feature view）——由 LocalDbGate
 *    在 gate 检查期间并行预加载并汇合（见 LocalDbGate 的 mainChunksReady），
 *    撤掉 AppShellCover（Splash）时主图已就绪，无闪帧。
 *
 * 生效机制：懒元素各自包 <Lazy>（Suspense fallback 固定 null——屏幕视觉由
 * AppShellCover 承接，与 LocalDbGate checking 阶段 return null 的约定一致；
 * 正常路径下预加载汇合保证此 fallback 不可见）。
 */
function Lazy({ children }: { children: ReactNode }): ReactElement {
  return <Suspense fallback={null}>{children}</Suspense>;
}

/** 命名导出 → React.lazy 组件：`lazyNamed(() => import('x'), 'X')`，收敛 27 条声明样板。
 * 泛型保留「导出名必须是该模块真实存在的键」的编译期检查；组件性用断言收窄
 * （模块里常混有非组件导出，如常量/工具函数，无法由类型系统整体约束）。 */
function lazyNamed<M, K extends keyof M & string>(
  loader: () => Promise<M>,
  name: K,
): LazyExoticComponent<ComponentType<object>> {
  return lazy(async () => ({
    default: (await loader())[name] as unknown as ComponentType<object>,
  }));
}

// —— 主功能区懒加载组件（清单与下方路由一一对应；LocalDbGate 预热 MainLayout
//    与 cc-agent 落地链，其余按导航时加载）——
const MainLayout = lazyNamed(() => import('@/components/layout/MainLayout'), 'MainLayout');
const SidebarWindowLayout = lazyNamed(
  () => import('@/components/layout/SidebarWindowLayout'),
  'SidebarWindowLayout',
);
const GhostPanelWindowLayout = lazyNamed(
  () => import('@/components/layout/GhostPanelWindowLayout'),
  'GhostPanelWindowLayout',
);
const CCAgentFeatureLayout = lazyNamed(
  () => import('@/features/cc-agent/CCAgentFeatureLayout'),
  'CCAgentFeatureLayout',
);
const CCAgentIndexRedirect = lazyNamed(
  () => import('@/features/cc-agent/CCAgentIndexRedirect'),
  'CCAgentIndexRedirect',
);
const SecondaryWindowBootGate = lazyNamed(
  () => import('@/features/cc-agent/SecondaryWindowBootGate'),
  'SecondaryWindowBootGate',
);
const CCAgentSessionView = lazyNamed(
  () => import('@/features/cc-agent/CCAgentSessionView'),
  'CCAgentSessionView',
);
const NewMakerDraftRoute = lazyNamed(
  () => import('@/features/cc-agent/NewMakerDraftRoute'),
  'NewMakerDraftRoute',
);
const OrcaWorkflowRoute = lazyNamed(
  () => import('@/features/cc-agent/OrcaWorkflowRoute'),
  'OrcaWorkflowRoute',
);
const WorkdirBrowseRoute = lazyNamed(
  () => import('@/features/cc-agent/workdir-browse/WorkdirBrowseRoute'),
  'WorkdirBrowseRoute',
);
const IssueTrackerFeatureLayout = lazyNamed(
  () => import('@/features/issue-tracker/IssueTrackerFeatureLayout'),
  'IssueTrackerFeatureLayout',
);
const SkillhubFeatureLayout = lazyNamed(
  () => import('@/features/skillhub/SkillhubFeatureLayout'),
  'SkillhubFeatureLayout',
);
const SkillhubHomeView = lazyNamed(() => import('@/features/skillhub/SkillhubHomeView'), 'SkillhubHomeView');
const SkillhubDetailView = lazyNamed(
  () => import('@/features/skillhub/SkillhubDetailView'),
  'SkillhubDetailView',
);
const SkillhubMarketListView = lazyNamed(
  () => import('@/features/skillhub/SkillhubMarketListView'),
  'SkillhubMarketListView',
);
const MakerExperimentalView = lazyNamed(
  () => import('@/features/maker-experimental/MakerExperimentalView'),
  'MakerExperimentalView',
);
const SchedulerPage = lazyNamed(() => import('@/features/scheduler'), 'SchedulerPage');
const GhostPluginPage = lazyNamed(() => import('@/features/plugin/GhostPluginPage'), 'GhostPluginPage');
const BotsFeatureLayout = lazyNamed(() => import('@/features/bots/BotsFeatureLayout'), 'BotsFeatureLayout');
const BotsHomeView = lazyNamed(() => import('@/features/bots/BotsHomeView'), 'BotsHomeView');
const BotHistorySessionView = lazyNamed(
  () => import('@/features/bots/BotHistorySessionView'),
  'BotHistorySessionView',
);
const BotRosterView = lazyNamed(() => import('@/features/bots/BotRosterView'), 'BotRosterView');
const BotSessionView = lazyNamed(() => import('@/features/bots/BotSessionView'), 'BotSessionView');
const BotDirectMessageView = lazyNamed(
  () => import('@/features/bots/BotDirectMessageView'),
  'BotDirectMessageView',
);
const RemoteBotSessionView = lazyNamed(
  () => import('@/features/bots/RemoteBotSessionView'),
  'RemoteBotSessionView',
);
const GhostMainViewFeatureLayout = lazyNamed(
  () => import('@/features/plugin/GhostMainViewFeatureLayout'),
  'GhostMainViewFeatureLayout',
);
const SettingsView = lazyNamed(() => import('@/components/settings/SettingsView'), 'SettingsView');

/**
 * 三层路由架构：
 *
 *   GuestRoute (未登录)
 *    └── /login                    → LoginPage
 *
 *   ProtectedRoute (已登录) — 校验 canEnterApp（真登出或换号窗口）
 *    └── LocalDbGate               → 等 localDb.ensureReady（按 userId 切库）
 *         └── MainLayout            → 主功能区
 *              ├── /                → Navigate to /cc-agent
 *              ├── /cc-agent/...    → CCAgentFeatureLayout
 *              ├── /bots/...        → BotsFeatureLayout
 *              └── /settings        → SettingsView
 *
 * LocalDbGate 下沉在路由层：AuthProvider 在 RouterProvider 之外无法 useNavigate。
 */
export const router = createHashRouter([
  {
    path: '/login',
    element: <GuestRoute />,
    // 登录线渲染崩溃时的全屏兜底(没有它 react-router 会渲染开发者默认错误页)。
    errorElement: <RouteErrorFallback />,
    children: [{ index: true, element: <LoginPage /> }],
  },
  {
    path: '/',
    element: <ProtectedRoute />,
    // 最外层兜底:MainLayout / 各 Gate 自身崩溃、或下层没有更近 errorElement 时
    // 冒泡到这里,全屏展示可恢复错误页(2026-07-09 React #130 事故的直接止血层)。
    errorElement: <RouteErrorFallback />,
    children: [
      {
        path: 'add-account',
        element: <AddAccountLoginPage />,
      },
      {
        // 主功能区入口 —— 经过 LocalDbGate（localDb 就绪）才能进
        element: <LocalDbGate />,
        children: [
          // 右侧栏独立子窗口(?sidebarWindow=1)的根路由 —— 与 MainLayout 平级,
          // 只挂 SidebarWindowLayout(50px chrome + RightSidebarShell),不挂完整壳。
          {
            path: 'sidebar-window',
            element: (
              <Lazy>
                <SidebarWindowLayout />
              </Lazy>
            ),
            errorElement: <RouteErrorFallback variant="section" />,
          },
          // 插件面板独立窗口(?ghostPanelWindow=<id>)的根路由 —— 同样与
          // MainLayout 平级,只挂 46px chrome + 面板体。
          {
            path: 'ghost-panel-window',
            element: (
              <Lazy>
                <GhostPanelWindowLayout />
              </Lazy>
            ),
            errorElement: <RouteErrorFallback variant="section" />,
          },
          {
            element: (
              <Lazy>
                <MainLayout />
              </Lazy>
            ),
            children: [
              {
                // pathless wrapper:内容区(cc-agent / skillhub / settings …)渲染
                // 崩溃时错误只占 outlet,保住 MainLayout 的导航 chrome,用户仍能
                // 切到其它页面;MainLayout 自身崩溃才冒泡到根级全屏兜底。
                errorElement: <RouteErrorFallback variant="section" />,
                children: [
                  { index: true, element: <Navigate to="/cc-agent" replace /> },
                  {
                    path: 'cc-agent',
                    element: (
                      <Lazy>
                        <CCAgentFeatureLayout />
                      </Lazy>
                    ),
                    children: [
                      {
                        index: true,
                        element: (
                          <Lazy>
                            <CCAgentIndexRedirect />
                          </Lazy>
                        ),
                      },
                      // 「在新窗口打开」副窗的启动网关(静态段,必须在 :sessionId 之前匹配)。
                      // 读 ?bootSession=<id> → resolveSessionRoute → navigate(replace),
                      // 让 Orca lead/worker 副窗首屏即落到分屏路由,见 SecondaryWindowBootGate。
                      {
                        path: 'boot',
                        element: (
                          <Lazy>
                            <SecondaryWindowBootGate />
                          </Lazy>
                        ),
                      },
                      // delayed-create: /cc-agent/new 是 transient draft 路由(无后端 session),
                      // 必须在 :sessionId 之前匹配,否则会被当作 sessionId='new' 进入 SessionView。
                      {
                        path: 'new',
                        element: (
                          <Lazy>
                            <NewMakerDraftRoute />
                          </Lazy>
                        ),
                      },
                      // 兼容旧 deep link:新建入口已收敛到同一个可切换 workspace 的创建页。
                      { path: 'new-dialogue', element: <Navigate to="/cc-agent/new" replace /> },
                      // Scheduled — 调度任务列表（与 new 同一层级，必须在 :sessionId 之前）
                      {
                        path: 'scheduled',
                        element: (
                          <Lazy>
                            <SchedulerPage />
                          </Lazy>
                        ),
                      },
                      // Workdir File Browser — 文件树视图(vscode-style),sidebar 自动 swap。
                      // 静态段 'files' 必须在 :sessionId 之前匹配。
                      {
                        path: 'files/:sessionId',
                        element: (
                          <Lazy>
                            <WorkdirBrowseRoute />
                          </Lazy>
                        ),
                      },
                      { path: 'orca/new', element: <Navigate to="/cc-agent/new" replace /> },
                      {
                        path: 'orca/:sessionId',
                        element: (
                          <Lazy>
                            <OrcaWorkflowRoute />
                          </Lazy>
                        ),
                      },
                      {
                        path: ':sessionId',
                        element: (
                          <Lazy>
                            <CCAgentSessionView />
                          </Lazy>
                        ),
                      },
                    ],
                  },
                  {
                    path: 'bots',
                    element: (
                      <Lazy>
                        <BotsFeatureLayout />
                      </Lazy>
                    ),
                    children: [
                      {
                        index: true,
                        element: (
                          <Lazy>
                            <BotsHomeView />
                          </Lazy>
                        ),
                      },
                      // 阵容是主区的一页,不是浮在对话上的模态。静态段排在 :botId
                      // 之前(React Router 也按静态优先定级),所以 /bots/roster 不会
                      // 被当成一个叫 "roster" 的伙伴。
                      {
                        path: 'roster',
                        element: (
                          <Lazy>
                            <BotRosterView />
                          </Lazy>
                        ),
                      },
                      {
                        path: 'remote/:deviceId/:botId',
                        element: (
                          <Lazy>
                            <RemoteBotSessionView />
                          </Lazy>
                        ),
                      },
                      // 伙伴私聊只从双方时间线里的消息入口打开，不出现在左侧伙伴列表。
                      {
                        path: ':botId/direct/:threadId',
                        element: (
                          <Lazy>
                            <BotDirectMessageView />
                          </Lazy>
                        ),
                      },
                      {
                        path: ':botId',
                        element: (
                          <Lazy>
                            <BotsHomeView />
                          </Lazy>
                        ),
                      },
                      {
                        path: ':botId/session/:sessionId',
                        element: (
                          <Lazy>
                            <BotSessionView />
                          </Lazy>
                        ),
                      },
                      {
                        path: ':botId/history/:sessionId',
                        element: (
                          <Lazy>
                            <BotHistorySessionView />
                          </Lazy>
                        ),
                      },
                    ],
                  },
                  {
                    // Issue Tracker — 已迁移至 GitHub，此处仅保留引导页
                    path: 'issues',
                    element: (
                      <Lazy>
                        <IssueTrackerFeatureLayout />
                      </Lazy>
                    ),
                  },
                  {
                    // SkillHub v0.2 —— Local skills (v0.2.1) + Market (v0.2.3)
                    path: 'skillhub',
                    element: (
                      <Lazy>
                        <SkillhubFeatureLayout />
                      </Lazy>
                    ),
                    children: [
                      { index: true, element: <Navigate to="/skillhub/local" replace /> },
                      {
                        path: 'local',
                        children: [
                          {
                            index: true,
                            element: (
                              <Lazy>
                                <SkillhubHomeView />
                              </Lazy>
                            ),
                          },
                          {
                            path: 'by-path',
                            element: (
                              <Lazy>
                                <SkillhubDetailView />
                              </Lazy>
                            ),
                          },
                          {
                            path: ':kind/global/:name',
                            element: (
                              <Lazy>
                                <SkillhubDetailView />
                              </Lazy>
                            ),
                          },
                          {
                            path: ':kind/project/:projectHash/:name',
                            element: (
                              <Lazy>
                                <SkillhubDetailView />
                              </Lazy>
                            ),
                          },
                        ],
                      },
                      {
                        path: 'market',
                        children: [
                          {
                            index: true,
                            element: (
                              <Lazy>
                                <SkillhubMarketListView />
                              </Lazy>
                            ),
                          },
                          // 全屏详情页/旧管理整页已移除(详情与管理统一走市场列表内的浮窗),
                          // 旧 URL 一律 fallback 回 market 列表
                          {
                            path: 'manage/:name',
                            element: <Navigate to="/skillhub/market" replace />,
                          },
                          { path: ':name', element: <Navigate to="/skillhub/market" replace /> },
                          {
                            path: ':kind/:name',
                            element: <Navigate to="/skillhub/market" replace />,
                          },
                        ],
                      },
                    ],
                  },
                  {
                    path: 'settings',
                    element: (
                      <Lazy>
                        <SettingsView />
                      </Lazy>
                    ),
                  },
                  {
                    path: 'plugins',
                    element: (
                      <Lazy>
                        <GhostPluginPage />
                      </Lazy>
                    ),
                  },
                  {
                    path: 'apps/:ghostId',
                    element: (
                      <Lazy>
                        <GhostMainViewFeatureLayout />
                      </Lazy>
                    ),
                  },
                  {
                    path: 'billing',
                    element: <Navigate to="/settings?tab=billing" replace />,
                  },
                  // Maker IPC / agent event 链路诊断页(独立路由,不影响标准 chat)。
                  {
                    path: 'maker-experimental',
                    element: (
                      <Lazy>
                        <MakerExperimentalView />
                      </Lazy>
                    ),
                  },
                ],
              },
            ],
          },
        ],
      },
    ],
  },
]);
