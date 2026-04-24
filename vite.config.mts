import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';
import electron from 'vite-plugin-electron';
import renderer from 'vite-plugin-electron-renderer';
import tailwindcss from '@tailwindcss/vite';
import { resolve } from 'path';

export default defineConfig({
  build: {
    rollupOptions: {
      input: {
        main: resolve(__dirname, 'index.html'),
        desktopLyric: resolve(__dirname, 'desktop-lyric.html'),
      },
    },
  },
  plugins: [
    vue(),
    tailwindcss(),
    electron([
      {
        entry: 'src/main/index.ts',
        onstart(options) {
          options.startup();
        },
        vite: {
          build: {
            outDir: 'dist-electron/main',
            emptyOutDir: true,
            rollupOptions: {
              external: ['electron', 'font-list'],
            },
          },
        },
      },
      {
        entry: 'src/preload/index.ts',
        onstart(options) {
          options.reload();
        },
        vite: {
          build: {
            outDir: 'dist-electron/preload', // 明确预加载脚本输出目录
            emptyOutDir: true,
          },
        },
      },
    ]),
    renderer(),
  ],
  server: {
    // dev 模式下 API 请求通过 IPC 直连 main 进程，不再需要 HTTP proxy
  },
  resolve: {
    alias: {
      '@': resolve(__dirname, 'src/renderer'),
    },
    extensions: ['.ts', '.tsx', '.mts', '.js', '.jsx', '.mjs', '.json', '.vue'],
  },
});
