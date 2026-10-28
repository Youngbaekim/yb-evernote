// YB-EverNote 서비스 워커 — 인터넷이 없어도 앱 화면이 열리도록 파일을 기기에 보관
// 노트 데이터는 Firestore가 따로 기기에 보관하므로 여기서는 다루지 않음
const VERSION = 'v0.6.7';
const SHELL = `yb-shell-${VERSION}`;
const FONTS = 'yb-fonts-v1';
const SCOPE = self.registration.scope; // https://…/yb-evernote/

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(SHELL).then((c) =>
      c.addAll([SCOPE, `${SCOPE}manifest.webmanifest`, `${SCOPE}icons/icon.svg`, `${SCOPE}icons/icon-192.png`])
    )
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k.startsWith('yb-shell-') && k !== SHELL).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

// 화면의 '새로고침' 버튼에서 보낸 신호 → 새 버전 즉시 적용
self.addEventListener('message', (e) => {
  if (e.data === 'skipWaiting') self.skipWaiting();
});

const isFont = (url) =>
  url.hostname === 'fonts.googleapis.com' || url.hostname === 'fonts.gstatic.com' ||
  (url.hostname === 'cdn.jsdelivr.net' && url.pathname.includes('pretendard'));

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  // 글꼴: 한 번 받으면 기기에 보관 (먼저 보관본 사용)
  if (isFont(url)) {
    e.respondWith(
      caches.open(FONTS).then(async (c) => {
        const hit = await c.match(req);
        if (hit) return hit;
        const res = await fetch(req);
        if (res.ok || res.type === 'opaque') c.put(req, res.clone()).catch(() => {});
        return res;
      })
    );
    return;
  }

  if (url.origin !== self.location.origin || !req.url.startsWith(SCOPE)) return; // Firebase 등 외부 요청은 관여하지 않음

  // 앱 첫 화면(index.html): 최신본 우선, 오프라인이면 보관본
  if (req.mode === 'navigate') {
    e.respondWith(
      fetch(req)
        .then((res) => {
          const copy = res.clone();
          if (res.ok) caches.open(SHELL).then((c) => c.put(SCOPE, copy));
          return res;
        })
        .catch(() => caches.match(SCOPE))
    );
    return;
  }

  // 빌드 파일·아이콘: 보관본 우선 (파일명에 버전이 붙어 있어 안전)
  e.respondWith(
    caches.match(req).then(
      (hit) =>
        hit ||
        fetch(req).then((res) => {
          const copy = res.clone();
          if (res.ok) caches.open(SHELL).then((c) => c.put(req, copy));
          return res;
        })
    )
  );
});
