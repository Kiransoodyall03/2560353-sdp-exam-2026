import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';
import { defineConfig, loadEnv } from 'vite';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));

export default defineConfig(({ mode }) => {
  // dev proxy target comes from the same .env the server reads (defaults mirror server/src/config.ts)
  const env = loadEnv(mode, repoRoot, ['SERVER_']);
  const target = `http://${env.SERVER_HOST || '127.0.0.1'}:${env.SERVER_PORT || '4000'}`;
  return {
    root: fileURLToPath(new URL('.', import.meta.url)),
    envDir: repoRoot,
    plugins: [react()],
    server: {
      proxy: { '/api': { target, changeOrigin: false } },
    },
    build: { outDir: 'dist', emptyOutDir: true, sourcemap: true },
  };
});
