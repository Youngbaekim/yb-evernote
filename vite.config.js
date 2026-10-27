import { defineConfig } from 'vite';

// GitHub Pages 주소: https://<계정>.github.io/yb-evernote/
export default defineConfig({
  base: '/yb-evernote/',
  build: { chunkSizeWarningLimit: 1500 },
});
