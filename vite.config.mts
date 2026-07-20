import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';
import electron from 'vite-plugin-electron';
import renderer from 'vite-plugin-electron-renderer';
import tailwindcss from '@tailwindcss/vite';
import { resolve } from 'path';
import { mkdirSync, writeFileSync } from 'fs';

const analyzeBundle = process.env.ANALYZE_BUNDLE === '1';
const bundleAnalysisPlugin = () => ({
  name: 'echo-bundle-analysis',
  generateBundle(
    _options: unknown,
    bundle: Record<string, { type: string; code?: string; source?: unknown }>,
  ) {
    if (!analyzeBundle) return;

    const assets = Object.entries(bundle)
      .map(([fileName, item]) => {
        const size =
          item.type === 'chunk'
            ? Buffer.byteLength(item.code ?? '', 'utf8')
            : typeof item.source === 'string'
              ? Buffer.byteLength(item.source, 'utf8')
              : item.source instanceof Uint8Array
                ? item.source.byteLength
                : 0;
        return { fileName, type: item.type, size };
      })
      .sort((a, b) => b.size - a.size);

    mkdirSync('release', { recursive: true });
    writeFileSync(
      'release/bundle-report.json',
      JSON.stringify({ generatedAt: new Date().toISOString(), assets }, null, 2),
    );
  },
});

export default defineConfig({
  build: {
    rollupOptions: {
      input: {
        main: resolve(__dirname, 'index.html'),
        desktopLyric: resolve(__dirname, 'desktop-lyric.html'),
        pluginWindow: resolve(__dirname, 'plugin-window.html'),
      },
    },
  },
  plugins: [
    vue(),
    tailwindcss(),
    bundleAnalysisPlugin(),
    electron([
      {
        entry: 'src/main/index.ts',
        onstart(options) {
          options.startup(['.', '--no-sandbox', '--no-stdio-init']);
        },
        vite: {
          build: {
            outDir: 'dist-electron/main',
            emptyOutDir: true,
            rollupOptions: {
              external: [
                'electron',
                'font-list',
                'electron-audio-loopback',
                '../../native/echo-media-controls',
                '../../native/echo-ffmpeg-player',
                '../../native/echo-sqlite-store',
              ],
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
  ].filter(Boolean),
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
