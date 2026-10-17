// The standalone updater does not load the Electron renderer's i18next runtime.
const RETRY_COPY = {
  'zh-CN': {
    retry: '重试',
    processes_running: '请先关闭 Watchdog 及从安装目录运行的其他进程，再重试',
    updater_busy: '另一项更新正在进行，请关闭此窗口后重新检查更新',
    in_progress: '更新重试已在进行中',
    unavailable: '当前更新失败不可重试',
    archive_unavailable: '更新文件已不存在或无法读取，请重新检查更新',
    spawn_failed: '无法启动重试更新，请关闭此窗口后重新检查更新',
  },
  en: {
    retry: 'Retry',
    processes_running:
      'Close Watchdog and any processes running from its installation folder, then retry',
    updater_busy:
      'Another update is already running. Close this window and check for updates again',
    in_progress: 'An update retry is already in progress',
    unavailable: 'This update failure cannot be retried',
    archive_unavailable: 'The update file is missing or unreadable. Please check for updates again',
    spawn_failed: 'Could not restart the updater. Close this window and check for updates again',
  },
};

globalThis.retryCopy = function retryCopy(language = 'en') {
  const locale = language.toLowerCase();
  if (locale === 'zh' || locale.startsWith('zh-')) return RETRY_COPY['zh-CN'];
  return RETRY_COPY[locale.split('-')[0]] || RETRY_COPY.en;
};
