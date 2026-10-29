import { defineConfig } from 'astro/config';
import solid from '@astrojs/solid-js';

// Static output only: the Worker serves ./dist through Workers Static Assets.
export default defineConfig({
  srcDir: './web',
  publicDir: './web/public',
  outDir: './dist',
  output: 'static',
  integrations: [solid()],
  build: { format: 'directory' },
  server: { port: 4321 },
  vite: { server: { proxy: { '/api': 'http://localhost:8787', '/auth': 'http://localhost:8787' } } },
});
