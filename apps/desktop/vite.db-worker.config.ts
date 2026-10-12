import { defineConfig } from 'vite';

export default defineConfig({
  resolve: {
    conditions: ['node'],
    mainFields: ['module', 'jsnext:main', 'jsnext'],
  },
  // worker 产物是 CJS 单文件（forge/dbWorkerTestUtils 都用 format: 'cjs'）。
  // rollup 在 CJS 输出里把 `import.meta.url` 替换成 `{}`，会让 worker 顶层的
  // `createRequire(import.meta.url)` 抛 ERR_INVALID_ARG_VALUE（filename undefined），
  // 直接导致真实 worker 启动即崩。这里显式把 import.meta.url 绑定到当前文件路径。
  define: {
    'import.meta.url': 'require("url").pathToFileURL(__filename).href',
  },
  build: {
    rollupOptions: {
      // db worker 是 Node worker_threads 运行时，原生模块必须在 packaged
      // app 的 node_modules / resources 中按平台解析，不能被 Vite bundle。
      external: [
        'better-sqlite3',
        'sqlite-vec',
        'drizzle-orm/better-sqlite3',
      ],
    },
  },
});
