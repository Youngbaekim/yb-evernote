// 보기 단계: 3열(폴더·목록·노트) → 2열(목록·노트) → 노트만
// - 창이 좁으면(노트 용지가 다 안 보이는 너비) 폴더 열은 자동으로 서랍(☰)으로
// - 단추(◧) 또는 Ctrl+\ 로 전환, 기기마다 마지막 상태를 기억
// - 휴대폰(680px 이하)은 기존처럼 한 번에 한 열
const KEY = 'yb-layout';
const WIDE = 1440; // 폴더 264 + 목록 320 + A4 용지(약 794)와 여백
const MOBILE = 680;
const LABEL = { 3: '폴더·목록·노트', 2: '목록·노트', 1: '노트만' };

let mode = (() => { try { return Number(localStorage.getItem(KEY)) || 3; } catch { return 3; } })();

const hasNote = () => { const t = document.getElementById('note-title'); return !!t && !t.disabled; }; // 열린 노트가 있으면 제목 칸이 켜져 있음

/** 지금 창에서 실제로 보이는 열 수 (휴대폰은 'm') */
function effective() {
  const w = window.innerWidth;
  if (w <= MOBILE) return 'm';
  if (mode === 1 && hasNote()) return 1; // 열린 노트가 없으면 목록은 보여 줌
  if (mode === 2 || w < WIDE) return 2;
  return 3;
}

function icon(cols) {
  // 바깥 틀 + 보이는 열은 채움
  const fill = (on) => (on ? 'currentColor' : 'none');
  return `<svg width="20" height="18" viewBox="0 0 20 18" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true">
    <rect x="1" y="1" width="18" height="16" rx="2.5"/>
    <rect x="3" y="3" width="3" height="12" rx="1" fill="${fill(cols >= 3)}" stroke-width="${cols >= 3 ? 0 : 1}"/>
    <rect x="7.5" y="3" width="3.5" height="12" rx="1" fill="${fill(cols >= 2)}" stroke-width="${cols >= 2 ? 0 : 1}"/>
  </svg>`;
}

export function applyLayout() {
  const app = document.getElementById('app');
  if (!app) return;
  const eff = effective();
  app.dataset.cols = String(eff);
  const btn = document.getElementById('btn-layout');
  if (btn && eff !== 'm') {
    const next = nextMode();
    btn.innerHTML = icon(eff);
    btn.title = `보기: ${LABEL[eff]} → 누르면 ${LABEL[next]} (Ctrl+\\)`;
    btn.setAttribute('aria-label', btn.title);
  }
}

/** 다음 단계: 넓은 창은 3→2→1→3, 좁은 창은 2↔1 */
function nextMode() {
  const eff = effective();
  const wide = window.innerWidth >= WIDE;
  if (eff === 3) return 2;
  if (eff === 2) return hasNote() ? 1 : wide ? 3 : 2;
  return wide ? 3 : 2;
}

export function cycleLayout() {
  if (effective() === 'm') return;
  mode = nextMode();
  try { localStorage.setItem(KEY, String(mode)); } catch { /* 무시 */ }
  const app = document.getElementById('app');
  if (app && app.dataset.view === 'folders') app.dataset.view = 'list'; // 열린 서랍은 닫기
  applyLayout();
}

window.addEventListener('resize', applyLayout);
// 노트를 열거나 닫을 때도 다시 계산
const titleEl = document.getElementById('note-title');
if (titleEl) new MutationObserver(applyLayout).observe(titleEl, { attributes: true, attributeFilter: ['disabled'] });
document.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && (e.code === 'Backslash' || e.key === '\\' || e.key === '₩')) {
    e.preventDefault();
    cycleLayout();
  }
});
