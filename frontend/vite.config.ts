/// <reference types="vitest/config" />
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const api = process.env.API_URL ?? 'http://localhost:3002';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5174,
    // /auth carries sign-in, the OIDC callback and logout; same origin keeps the session cookie first-party.
    proxy: { '/api': api, '/auth': api },
  },
  test: { environment: 'node', include: ['src/**/*.test.ts'] },
});
