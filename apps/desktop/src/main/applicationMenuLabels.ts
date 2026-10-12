/**
 * macOS 原生应用菜单的中英双语标签。
 *
 * 单独成模块是为了**能被术语门禁扫到**。它和 i18next 的 locale JSON 一样是用户可见
 * 文案,但不走 i18next,check-i18n-glossary.mjs 只读 locale JSON 扫不到它——引入术语表
 * 时这里就漏掉了「议题」(Issue 的禁用译法)和三处 ASCII 省略号,而这是 macOS 上一直
 * 挂在屏幕顶端的菜单栏。
 *
 * 覆盖它的是 __tests__/applicationMenuLabels.test.ts,与 mobile 影子 catalog 同一套路子:
 * vitest 直接 import 运行时对象,复用 scripts/shared/glossary-rules.mjs 的判定。
 * 之所以要抽出来,是因为原先它嵌在 bootstrap-electron.ts 里,测试一 import 就会拉起
 * 整个 Electron 主进程模块。
 *
 * `installCli*` 一组里的 `{{cmd}}` 是**命令名占位符**,由调用侧按本构建 edition 品牌
 * 替换(global/cn → `cindy`,dev → `cindydev`,见 installCliCommand.ts 的
 * CLI_COMMAND_NAME);`{{path}}` 替换为 symlink 安装路径。文案里的 “Cindy” 指产品/应用
 * 本身,不随命令名变化,故保留。
 */
import type { SupportedLocale } from '../shared/locale.js';

export type ApplicationMenuLocale = SupportedLocale;

export interface ApplicationMenuLabels {
  about: string;
  hide: string;
  quit: string;
  settings: string;
  checkForUpdates: string;
  fileMenu: string;
  newMaker: string;
  viewMenu: string;
  toggleSidebar: string;
  windowMenu: string;
  helpMenu: string;
  help: string;
  releaseNotes: string;
  issues: string;
  installCli: string;
  installCliConfirmTitle: string;
  installCliConfirmDetail: string;
  installCliConfirmOk: string;
  installCliCancel: string;
  installCliSuccessTitle: string;
  installCliSuccessDetail: string;
  installCliErrorTitle: string;
  installCliErrorDetail: string;
  installCliDevOnlyTitle: string;
  installCliDevOnlyDetail: string;
  installCliUnsupportedTitle: string;
  installCliUnsupportedDetail: string;
  installCliNotInApplicationsTitle: string;
  installCliNotInApplicationsDetail: string;
  installCliMoveToApplications: string;
}

export const APPLICATION_MENU_LABELS: Record<ApplicationMenuLocale, ApplicationMenuLabels> = {
  'zh-CN': {
    about: '关于 {{appName}}',
    hide: '隐藏 {{appName}}',
    quit: '退出 {{appName}}',
    settings: '设置…',
    checkForUpdates: '检查更新…',
    fileMenu: '文件',
    newMaker: '新建任务',
    viewMenu: '显示',
    toggleSidebar: '切换侧边栏',
    windowMenu: '窗口',
    helpMenu: '帮助',
    help: '帮助',
    releaseNotes: '最新更新介绍',
    issues: '问题反馈',
    installCli: '安装到命令行',
    installCliConfirmTitle: '把 {{cmd}} 命令安装到命令行？',
    installCliConfirmDetail:
      '将在 {{path}} 创建指向 Cindy 的符号链接；若该路径已存在同名文件，会被替换。之后在终端运行 {{cmd}} . 即可把当前目录作为工作目录在 Cindy 中打开。系统会请求你的管理员密码以写入该目录。',
    installCliConfirmOk: '安装',
    installCliCancel: '取消',
    installCliSuccessTitle: '{{cmd}} 命令已安装',
    installCliSuccessDetail:
      '已安装到 {{path}}。重开一个终端窗口后运行 {{cmd}} . 即可。若提示找不到命令，请确认该目录在你的 PATH 中。',
    installCliErrorTitle: '安装失败',
    installCliErrorDetail: '未能安装 {{cmd}} 命令。',
    installCliDevOnlyTitle: '仅正式版可用',
    installCliDevOnlyDetail:
      '开发模式下无法安装命令行工具：此时的可执行文件指向 Electron 解释器，而非 Cindy 应用。请在正式安装的 Cindy 中使用此功能。',
    installCliUnsupportedTitle: '暂不支持当前系统',
    installCliUnsupportedDetail: '安装到命令行目前仅支持 macOS。',
    installCliNotInApplicationsTitle: '请先把 Cindy 移动到「应用程序」文件夹',
    installCliNotInApplicationsDetail:
      '当前 Cindy 运行在临时位置（不在「应用程序」文件夹里）。此时安装的命令会指向这个临时路径，应用退出或磁盘弹出后即失效。请先把 Cindy 移动到「应用程序」文件夹，再安装命令行。',
    installCliMoveToApplications: '移动到「应用程序」',
  },
  en: {
    about: 'About {{appName}}',
    hide: 'Hide {{appName}}',
    quit: 'Quit {{appName}}',
    settings: 'Settings…',
    checkForUpdates: 'Check for Updates…',
    fileMenu: 'File',
    newMaker: 'New Session',
    viewMenu: 'View',
    toggleSidebar: 'Toggle Sidebar',
    windowMenu: 'Window',
    helpMenu: 'Help',
    help: 'Help',
    releaseNotes: "What's New",
    issues: 'Issues',
    installCli: "Install '{{cmd}}' Command in PATH",
    installCliConfirmTitle: "Install the '{{cmd}}' command in your PATH?",
    installCliConfirmDetail:
      'A symlink to Cindy will be created at {{path}}; if a file already exists there, it will be replaced. You can then run `{{cmd}} .` in a terminal to open the current directory as a working directory in Cindy. You will be asked for your administrator password to write to that location.',
    installCliConfirmOk: 'Install',
    installCliCancel: 'Cancel',
    installCliSuccessTitle: "'{{cmd}}' command installed",
    installCliSuccessDetail:
      'Installed at {{path}}. Open a new terminal window and run `{{cmd}} .`. If the command is not found, make sure that directory is on your PATH.',
    installCliErrorTitle: 'Installation failed',
    installCliErrorDetail: "Could not install the '{{cmd}}' command.",
    installCliDevOnlyTitle: 'Packaged build only',
    installCliDevOnlyDetail:
      'The command-line tool cannot be installed in development mode: the executable points at the Electron runtime rather than the Cindy app. Use this from an installed Cindy build.',
    installCliUnsupportedTitle: 'Not supported on this system',
    installCliUnsupportedDetail: "Installing the '{{cmd}}' command is currently supported on macOS only.",
    installCliNotInApplicationsTitle: 'Move Cindy to the Applications folder first',
    installCliNotInApplicationsDetail:
      'Cindy is running from a temporary location (not the Applications folder). A command installed now would point at that temporary path and break as soon as the app quits or the volume is ejected. Move Cindy to the Applications folder, then install the command.',
    installCliMoveToApplications: 'Move to Applications',
  },
};
