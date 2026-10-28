// 노트 배율 — 노트 내용(글자·그림)만 확대·축소, 프레임과 용지 폭은 그대로
// - 그림은 용지 폭에서 멈추고(이미 max-width 100%), 필기 블록은 항상 용지 폭 (style.css)
// - 단추 · 노트 위 Ctrl+휠 · 두 손가락 벌리기, 기기마다 기억, 인쇄는 항상 100%
const KEY = 'yb-note-zoom';
export const ZOOM_STEPS = [0.5, 0.67, 0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2];
const MIN = ZOOM_STEPS[0];
const MAX = ZOOM_STEPS[ZOOM_STEPS.length - 1];

let z = (() => { try { const v = Number(localStorage.getItem(KEY)); return v >= MIN && v <= MAX ? v : 1; } catch { return 1; } })();
export const getZoom = () => z;

const sheet = () => document.getElementById('editor');
const wrap = () => document.querySelector('.editor-wrap');

function render() {
  sheet()?.style.setProperty('--z', String(z));
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
    setZoom(Math.round(next * 20) / 20); // 5% 단위
  };
  w.addEventListener('touchend', (e) => { if (e.touches.length < 2) end(); });
  w.addEventListener('touchcancel', end);
  // iPhone·iPad Safari: 화면 전체 확대 대신 노트 배율로
  document.addEventListener('gesturestart', (e) => { if (w.contains(e.target)) e.preventDefault(); });
}
