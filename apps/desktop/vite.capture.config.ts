import { defineConfig } from 'vite';
import path from 'node:path';
import { bootTimingPlugin } from './vite-boot-timing';

// Separate module graph: no App, Markdown, plugins, React providers or chat preload.
export default defineConfig({
  root: path.resolve(__dirname, 'src/capture-renderer'),
  base: './',
  // Never reuse the main renderer's prebundle: it has a different module graph.
  cacheDir: path.resolve(__dirname, 'node_modules/.vite/desktop-capture'),
  // These workspace packages expose ESM TypeScript, including a transitive
  // protocol package. Resolve them from source rather than relocating imports.
  optimizeDeps: { exclude: ['@cindy/device-link', '@cindy/device-link-protocol'] },
  server: { hmr: false },
  // Dev 启动分段探针：capture server 有独立 cacheDir（node_modules/.vite/desktop-capture），
  // 首次启动要做自己的 dep 预打包——用它验证它是否参与拉长「main config→首目标」构建窗。
  plugins: [bootTimingPlugin('renderer.desktop_capture')],
  build: {
    emptyOutDir: true,
    outDir: path.resolve(__dirname, '.vite/renderer/desktop_capture'),
    rollupOptions: { output: { inlineDynamicImports: true } },
  },
});
