import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';
import { resolve } from 'path';
import eslint from 'vite-plugin-eslint';

export default defineConfig({
  base: './',
  plugins: [
    vue(),
    eslint({
      cache: false,
      include: ['./src/**/*.js', './src/**/*.ts', './src/**/*.vue'],
    }),
  ],
  resolve: {
    alias: {
      '@': resolve(__dirname, 'src'),
    },
  },
  server: {
    host: '0.0.0.0',
    port: 3000,
  },
  build: {
    outDir: 'dist',
    rollupOptions: {
      input: {
        main: resolve(__dirname, 'index.html'),
        'desktop-lyrics': resolve(__dirname, 'public/desktop-lyrics.html'),
      },
    },
  },
});
