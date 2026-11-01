// 보기 단계: 3열(폴더·목록·노트) → 2열(목록·노트) → 노트만
// - 창이 좁으면(노트 용지가 다 안 보이는 너비) 폴더 열은 자동으로 서랍(☰)으로
// - 단추(◧) 또는 Ctrl+\ 로 전환, 기기마다 마지막 상태를 기억
// - 휴대폰(680px 이하)은 기존처럼 한 번에 한 열
const KEY = 'yb-layout';
// 열 너비: 경계선을 끌어 조절, 기기마다 기억 (두 번 누르면 기본값)
const WKEY = 'yb-widths';
const DEF = { folders: 264, list: 320 };
const LIMIT = { folders: [180, 420], list: [220, 600] };
const EDITOR_MIN = 420; // 노트 영역 최소 너비
const SHEET = 856; // A4 용지(약 794)와 여백
// 목록 접기 = '노트만' 보기와 같은 상태 (◧ 아이콘·손잡이가 늘 일치)
// - 경계선을 최소 너비보다 더 밀면 '노트만'으로 전환 (3열이면 폴더 열도 함께 숨김)
// - '노트만' 상태에서는 노트 왼쪽 가장자리에 손잡이가 늘 보이고, 끌거나 누르면 접기 전 보기로 복귀
const PKEY = 'yb-layout-prev';
const COLLAPSE_PAST = 70; // 최소 너비에서 이만큼 더 밀면 접힘
let prevMode = (() => { try { return Number(localStorage.getItem(PKEY)) || 3; } catch { return 3; } })();
let widths = (() => { try { return { ...DEF, ...JSON.parse(localStorage.getItem(WKEY) || '{}') }; } catch { return { ...DEF }; } })();
// 이 너비 이상이면 3열 (기본 1440). 열을 좁히면 더 좁은 창에서도 3열, 넓혀도 갑자기 2열로 바뀌지는 않음
const wideAt = () => Math.min(DEF.folders + DEF.list, widths.folders + widths.list) + SHEET;
const MOBILE = 680;
const LABEL = { 3: '폴더·목록·노트', 2: '목록·노트', 1: '노트만' };

let mode = (() => { try { return Number(localStorage.getItem(KEY)) || 3; } catch { return 3; } })();
// 이전 버전의 '목록 접힘' 기록은 '노트만'으로 옮김
try { if (localStorage.getItem('yb-list-collapsed') === '1') { prevMode = mode === 1 ? 3 : mode; mode = 1; localStorage.setItem(KEY, '1'); } localStorage.removeItem('yb-list-collapsed'); } catch { /* 무시 */ }
function setMode(m) {
  if (m === 1 && mode !== 1) { prevMode = mode; try { localStorage.setItem(PKEY, String(prevMode)); } catch { /* 무시 */ } }
  mode = m;
  try { localStorage.setItem(KEY, String(mode)); } catch { /* 무시 */ }
}

const hasNote = () => { const t = document.getElementById('note-title'); return !!t && !t.disabled; }; // 열린 노트가 있으면 제목 칸이 켜져 있음

/** 지금 창에서 실제로 보이는 열 수 (휴대폰은 'm') */
function effective() {
  const w = window.innerWidth;
  if (w <= MOBILE) return 'm';
  if (mode === 1 && hasNote()) return 1; // 열린 노트가 없으면 목록은 보여 줌
  if (mode === 2 || w < wideAt()) return 2;
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
  app.style.setProperty('--w-folders', `${widths.folders}px`);
  app.style.setProperty('--w-list', `${widths.list}px`);
  ensureResizers(app);
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
  const wide = window.innerWidth >= wideAt();
  if (eff === 3) return 2;
  if (eff === 2) return hasNote() ? 1 : wide ? 3 : 2;
  return wide ? 3 : 2;
}

export function cycleLayout() {
  if (effective() === 'm') return;
  setMode(nextMode());
  const app = document.getElementById('app');
  if (app && app.dataset.view === 'folders') app.dataset.view = 'list'; // 열린 서랍은 닫기
  applyLayout();
}

/* ───── 경계선 끌기 ───── */
function ensureResizers(app) {
  for (const [kind, sel] of [['folders', '.pane-folders'], ['list', '.pane-list']]) {
    const pane = app.querySelector(sel);
    if (!pane || pane.querySelector(':scope > .pane-resizer')) continue;
    const h = document.createElement('div');
    h.className = 'pane-resizer';
    h.dataset.resize = kind;
    h.title = '끌어서 너비 조절 · 두 번 누르면 기본 너비';
    h.setAttribute('role', 'separator');
    h.setAttribute('aria-orientation', 'vertical');
    h.addEventListener('pointerdown', (e) => startResize(e, kind, h));
    h.addEventListener('dblclick', () => {
      widths[kind] = DEF[kind];
      saveWidths();
      applyLayout();
    });
    pane.appendChild(h);
  }
  ensureReopenHandle(app);
}

/** 노트 왼쪽 가장자리의 '목록 다시 열기' 손잡이 ('노트만' 상태에서 늘 표시)
 *  누르면 접기 전 보기로 돌아가며 목록은 최소 너비로 바로 열리고, 그대로 끌면 계속 넓어짐 (◧ 아이콘도 같이 바뀜) */
function ensureReopenHandle(app) {
  const pane = app.querySelector('.pane-editor');
  if (!pane || pane.querySelector(':scope > .list-reopen')) return;
  const h = document.createElement('button');
  h.type = 'button';
  h.className = 'list-reopen';
  h.title = '노트 목록 열기 (끌어서 너비 조절)';
  h.setAttribute('aria-label', '노트 목록 열기');
  h.innerHTML = '<span>›</span>';
  h.addEventListener('pointerdown', (e) => {
    if (e.button > 0) return;
    e.preventDefault();
    setMode(prevMode && prevMode !== 1 ? prevMode : 3);
    widths.list = LIMIT.list[0]; // 최소 너비로 한 번에 열기
    applyLayout();
    startResize(e, 'list', null, LIMIT.list[0]); // 이어서 끌면 그대로 너비 조절
  });
  pane.appendChild(h);
}

function saveWidths() {
  try { localStorage.setItem(WKEY, JSON.stringify(widths)); } catch { /* 무시 */ }
}

function startResize(e, kind, h, w0Override) {
  if (e.button > 0) return;
  e.preventDefault();
  const app = document.getElementById('app');
  const x0 = e.clientX;
  const w0 = w0Override ?? widths[kind];
  const cols = app.dataset.cols;
  // 노트 영역이 너무 좁아지지 않게 (나머지 열 너비를 뺀 범위 안에서)
  const others = kind === 'folders' ? widths.list : cols === '3' ? widths.folders : 0;
  const [lo, hi0] = LIMIT[kind];
  const hi = Math.max(lo, Math.min(hi0, window.innerWidth - others - EDITOR_MIN));
  document.body.classList.add('resizing-cols');
  h?.classList.add('on');
  let raf = 0;
  let collapsing = false;
  const cols0 = app.dataset.cols;
  const canCollapse = kind === 'list' && hasNote(); // 열린 노트가 없으면 접지 않음
  const move = (ev) => {
    const raw = w0 + ev.clientX - x0;
    if (canCollapse) {
      // 최소 너비보다 더 밀면 '노트만'으로 미리 보여 주기 (다시 당기면 원래대로)
      const c = raw < lo - COLLAPSE_PAST;
      if (c !== collapsing) {
        collapsing = c;
        app.dataset.cols = c ? '1' : cols0;
      }
      if (c) return;
    }
    widths[kind] = Math.round(Math.min(hi, Math.max(lo, raw)));
    if (!raf) raf = requestAnimationFrame(() => {
      raf = 0;
      app.style.setProperty(`--w-${kind}`, `${widths[kind]}px`);
    });
  };
  const up = () => {
    window.removeEventListener('pointermove', move);
    window.removeEventListener('pointerup', up);
    window.removeEventListener('pointercancel', up);
    document.body.classList.remove('resizing-cols');
    h?.classList.remove('on');
    if (collapsing) {
      setMode(1); // '노트만' (◧ 아이콘도 같은 상태)
      widths.list = Math.max(lo, w0); // 다음에 열 때를 위해 너비는 정상 범위로
    }
    saveWidths();
    applyLayout();
  };
  // 창 전체에서 추적 (손잡이가 사라지거나 바뀌어도 끌기가 이어지도록)
  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', up);
  window.addEventListener('pointercancel', up);
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
