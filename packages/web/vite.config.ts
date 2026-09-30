import { defineConfig } from 'vite';

// In development the API runs on its own port; /api is forwarded to it, the same way nginx does
// it in Docker, so the browser code always calls /api/... and never needs CORS.
export default defineConfig({
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: process.env['API_URL'] ?? 'http://localhost:3000',
        rewrite: (path) => path.replace(/^\/api/, ''),
      },
    },
  },
  build: {
    target: 'es2022',
  },
});
