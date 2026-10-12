import { defineConfig } from 'vite';

export default defineConfig({
  resolve: {
    conditions: ['node'],
    mainFields: ['module', 'jsnext:main', 'jsnext'],
  },
  // worker 源码已用 `typeof __filename === 'string' ? __filename : import.meta.url`
  // 兼容 CJS；不要再给 import.meta.url 配表达式 define，Vite 只接受实体名或字面量。
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
