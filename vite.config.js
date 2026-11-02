import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';

// GitHub Pages 주소: https://<계정>.github.io/yb-evernote/
// 두 쪽: index.html(편집 앱) · view.html(웹에 게시한 노트 열람)
export default defineConfig({
  base: '/yb-evernote/',
  build: {
    chunkSizeWarningLimit: 1500,
    rollupOptions: {
      input: {
        main: fileURLToPath(new URL('./index.html', import.meta.url)),
        view: fileURLToPath(new URL('./view.html', import.meta.url)),
      },
    },
  },
});
