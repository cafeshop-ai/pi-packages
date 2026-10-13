import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  root: fileURLToPath(new URL('./', import.meta.url)),
  publicDir: fileURLToPath(new URL('./static/', import.meta.url)),
  base: '/',
  plugins: [react(), tailwindcss()],
  resolve: { alias: { '@': fileURLToPath(new URL('./src/', import.meta.url)) } },
  server: { host: '127.0.0.1', strictPort: true },
  build: {
    outDir: fileURLToPath(new URL('../.refactor/web/', import.meta.url)),
    emptyOutDir: true,
    sourcemap: false,
    target: 'es2022',
    assetsDir: 'assets',
  },
});
