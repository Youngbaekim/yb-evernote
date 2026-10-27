// 다크 모드 선택: system(기기 설정 따름) · dark(항상 켜기) · light(항상 끄기)
// 기기마다 따로 기억 (PC는 끄고 폰은 시스템 설정을 따르는 식으로 쓸 수 있게)
// 방식: 스타일시트의 @media (prefers-color-scheme: dark) 규칙을 켜거나(all) 끄거나(not all) 원래대로 되돌림
const KEY = 'yb-theme';
const orig = new WeakMap();

export function getTheme() {
  try { return localStorage.getItem(KEY) || 'system'; } catch { return 'system'; }
}

function walk(rules, media) {
  for (const r of rules) {
    if (r.media && r.cssRules) {
      if (!orig.has(r) && /prefers-color-scheme\s*:\s*dark/.test(r.media.mediaText)) orig.set(r, r.media.mediaText);
      if (orig.has(r)) r.media.mediaText = media ?? orig.get(r);
    }
  }
}

export function applyTheme(mode = getTheme()) {
  const media = mode === 'dark' ? 'all' : mode === 'light' ? 'not all' : null;
  for (const sheet of document.styleSheets) {
    let rules;
    try { rules = sheet.cssRules; } catch { continue; } // 외부 글꼴 스타일시트 등은 건너뜀
    walk(rules, media);
  }
  const root = document.documentElement;
  root.style.colorScheme = mode === 'system' ? '' : mode; // 스크롤바·입력칸 색도 함께
  root.dataset.theme = mode;
}

export function setTheme(mode) {
  try { localStorage.setItem(KEY, mode); } catch { /* 무시 */ }
  applyTheme(mode);
}

applyTheme();
window.addEventListener('load', () => applyTheme());
