// 노트 배율 — 노트 내용(글자·그림)만 확대·축소, 프레임과 용지 폭은 그대로
// - 그림은 용지 폭에서 멈추고(이미 max-width 100%), 필기 블록은 항상 용지 폭 (style.css)
// - 단추 · 노트 위 Ctrl+휠 · 두 손가락 벌리기, 기기마다 기억, 인쇄는 항상 100%
const KEY = 'yb-note-zoom';
// 80~120%는 5% 단위, 그 밖은 10% 단위
export const ZOOM_STEPS = [0.5, 0.6, 0.7, 0.8, 0.85, 0.9, 0.95, 1, 1.05, 1.1, 1.15, 1.2, 1.3, 1.4, 1.5, 1.6, 1.7, 1.8, 1.9, 2];
const snap = (v) => ZOOM_STEPS.reduce((a, b) => (Math.abs(b - v) < Math.abs(a - v) ? b : a));
const MIN = ZOOM_STEPS[0];
const MAX = ZOOM_STEPS[ZOOM_STEPS.length - 1];

let z = (() => { try { const v = Number(localStorage.getItem(KEY)); return v >= MIN && v <= MAX ? v : 1; } catch { return 1; } })();
export const getZoom = () => z;

const sheet = () => document.getElementById('editor');
const wrap = () => document.querySelector('.editor-wrap');

function render() {
  sheet()?.style.setProperty('--z', String(z));
  applySheet();
  const val = document.getElementById('btn-zoom-reset');
  if (val) val.textContent = `${Math.round(z * 100)}%`;
  document.getElementById('zoom-group')?.classList.toggle('changed', Math.abs(z - 1) > 0.001);
  const out = document.getElementById('btn-zoom-out');
  const inn = document.getElementById('btn-zoom-in');
  if (out) out.disabled = z <= MIN + 0.001;
  if (inn) inn.disabled = z >= MAX - 0.001;
}

/** 배율 변경 — 화면에 보이던 글 위치가 크게 튀지 않도록 스크롤 비율 유지 */
export function setZoom(next) {
  next = Math.min(MAX, Math.max(MIN, Math.round(next * 100) / 100));
  if (Math.abs(next - z) < 0.001) return;
  const w = wrap();
  const ratio = w && w.scrollHeight > w.clientHeight ? w.scrollTop / (w.scrollHeight - w.clientHeight) : 0;
  z = next;
  try { localStorage.setItem(KEY, String(z)); } catch { /* 무시 */ }
  render();
  if (w) requestAnimationFrame(() => { w.scrollTop = ratio * (w.scrollHeight - w.clientHeight); });
}

export function stepZoom(dir) {
  const next = dir > 0 ? ZOOM_STEPS.find((v) => v > z + 0.001) : [...ZOOM_STEPS].reverse().find((v) => v < z - 0.001);
  if (next) setZoom(next);
}

export function initNoteZoom() {
  initSheetGrips();
  render();
  document.getElementById('btn-zoom-in')?.addEventListener('click', () => stepZoom(1));
  document.getElementById('btn-zoom-out')?.addEventListener('click', () => stepZoom(-1));
  document.getElementById('btn-zoom-reset')?.addEventListener('click', () => setZoom(1));
  const w = wrap();
  if (!w) return;

  // PC: 노트 위에서 Ctrl+휠 (노트북 터치패드 두 손가락 벌리기 포함). 쓰는 중인 필기 블록 위는 필기 확대에 양보
  w.addEventListener('wheel', (e) => {
    if (!e.ctrlKey || e.defaultPrevented || e.target.closest?.('.drawing-block.active')) return;
    e.preventDefault();
    stepZoom(e.deltaY < 0 ? 1 : -1);
  }, { passive: false });

  // 태블릿·휴대폰: 두 손가락 벌리기·오므리기 (손가락을 뗄 때 배율 적용, 그 전에는 화면만 늘려 미리보기)
  let pinch = null;
  const dist = (t) => Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY);
  w.addEventListener('touchstart', (e) => {
    if (e.touches.length !== 2 || e.target.closest?.('.drawing-block.active')) return;
    const r = sheet().getBoundingClientRect();
    const cx = (e.touches[0].clientX + e.touches[1].clientX) / 2 - r.left;
    const cy = (e.touches[0].clientY + e.touches[1].clientY) / 2 - r.top;
    pinch = { d0: dist(e.touches) || 1, next: z };
    sheet().style.transformOrigin = `${cx}px ${cy}px`;
  }, { passive: true });
  w.addEventListener('touchmove', (e) => {
    if (!pinch || e.touches.length !== 2) return;
    e.preventDefault();
    pinch.next = Math.min(MAX, Math.max(MIN, z * (dist(e.touches) / pinch.d0)));
    sheet().style.transform = `scale(${pinch.next / z})`;
  }, { passive: false });
  const end = () => {
    if (!pinch) return;
    const { next } = pinch;
    pinch = null;
    sheet().style.transform = '';
    setZoom(snap(next)); // 가장 가까운 단계로
  };
  w.addEventListener('touchend', (e) => { if (e.touches.length < 2) end(); });
  w.addEventListener('touchcancel', end);
  // iPhone·iPad Safari: 화면 전체 확대 대신 노트 배율로
  document.addEventListener('gesturestart', (e) => { if (w.contains(e.target)) e.preventDefault(); });
}

/* ───── 용지 크기: 좌우 가장자리를 끌어 비율 그대로 크게 (A4 모양·줄바꿈 유지) ─────
   - 용지 전체(여백·글자·그림·필기)를 같은 비율로 키움 → 인쇄본과 같은 줄바꿈 유지
   - 100%(A4 폭) 미만으로는 줄지 않고, 노트 영역 폭을 넘지 않음. 두 번 누르면 100% */
const SKEY = 'yb-sheet-scale';
const A4_PX = 793.7; // 210mm
const S_MAX = 2;
let sheetScale = (() => { try { const v = Number(localStorage.getItem(SKEY)); return v >= 1 && v <= S_MAX ? v : 1; } catch { return 1; } })();

/** 노트 영역에서 허용되는 최대 배율 (용지 + 바깥 여백 24px×2) */
function maxScale() {
  const w = wrap();
  if (!w) return 1;
  return Math.min(S_MAX, (w.clientWidth - 4) / (A4_PX + 48));
}
let shownScale = 1;
function applySheet(live) {
  const ed = sheet();
  if (!ed) return;
  const mx = maxScale();
  shownScale = mx <= 1 ? 1 : Math.min(live ?? sheetScale, mx);
  ed.style.setProperty('--s', String(Math.round(shownScale * 1000) / 1000));
  ed.classList.toggle('can-grow', mx > 1.01);
  placeGrips();
}

/** 손잡이 표시 위치: 용지가 길어도 늘 화면(노트 영역)에 보이는 부분의 세로 가운데 */
let gripRaf = 0;
function placeGrips() {
  if (gripRaf) return;
  gripRaf = requestAnimationFrame(() => {
    gripRaf = 0;
    const ed = sheet();
    const w = wrap();
    if (!ed || !w || ed.hidden) return;
    const er = ed.getBoundingClientRect();
    const wr = w.getBoundingClientRect();
    const top = Math.max(er.top, wr.top);
    const bottom = Math.min(er.bottom, wr.bottom);
    if (bottom <= top) return;
    const y = (top + bottom) / 2 - er.top; // 화면 좌표(배율 적용된 값)
    ed.style.setProperty('--grip-y', `${Math.round(y / (shownScale || 1))}px`); // 용지 안 좌표로 환산
  });
}

function initSheetGrips() {
  const ed = sheet();
  if (!ed || ed.querySelector('.sheet-grip')) return;
  const tip = document.createElement('div');
  tip.className = 'sheet-tip';
  tip.hidden = true;
  ed.appendChild(tip);
  for (const side of ['left', 'right']) {
    const g = document.createElement('div');
    g.className = `sheet-grip ${side}`;
    g.title = '끌어서 용지 크기 조절 (비율 유지) · 두 번 누르면 원래 크기';
    g.addEventListener('dblclick', () => { sheetScale = 1; saveSheet(); applySheet(); });
    g.addEventListener('pointerdown', (e) => {
      if (e.button > 0) return;
      e.preventDefault();
      try { g.setPointerCapture(e.pointerId); } catch { /* 무시 */ }
      const x0 = e.clientX;
      const s0 = shownScale;
      const mx = maxScale();
      let next = s0;
      document.body.classList.add('resizing-sheet');
      tip.hidden = false;
      const move = (ev) => {
        const dx = (ev.clientX - x0) * (side === 'right' ? 1 : -1);
        next = Math.min(Math.max(1, (A4_PX * s0 + 2 * dx) / A4_PX), Math.max(1, mx));
        next = Math.round(next * 100) / 100;
        applySheet(next);
        tip.textContent = `용지 ${Math.round(next * 100)}%`;
      };
      const up = () => {
        g.removeEventListener('pointermove', move);
        g.removeEventListener('pointerup', up);
        g.removeEventListener('pointercancel', up);
        document.body.classList.remove('resizing-sheet');
        tip.hidden = true;
        sheetScale = next;
        saveSheet();
        applySheet();
      };
      g.addEventListener('pointermove', move);
      g.addEventListener('pointerup', up);
      g.addEventListener('pointercancel', up);
    });
    ed.appendChild(g);
  }
  const w = wrap();
  if (w) {
    new ResizeObserver(() => applySheet()).observe(w);
    w.addEventListener('scroll', placeGrips, { passive: true });
  }
  new ResizeObserver(placeGrips).observe(ed); // 글이 길어지거나 노트를 바꿀 때
}
function saveSheet() { try { localStorage.setItem(SKEY, String(sheetScale)); } catch { /* 무시 */ } }
