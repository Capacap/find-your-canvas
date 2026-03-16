import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [sveltekit()],
  server: {
    port: 5173,
    strictPort: true
  },
  test: {
    include: ['eval/**/*.eval.ts'],
    testTimeout: 120_000,
    hookTimeout: 30_000,
    sequence: { concurrent: false },
    reporters: ['verbose'],
    disableConsoleIntercept: true
  }
});
