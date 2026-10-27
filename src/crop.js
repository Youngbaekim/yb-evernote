// 그림 자르기 창 — 원본은 그대로 두고 보여 줄 영역(비율 0~1)만 돌려줌 (비파괴)
// 회전도 원본을 바꾸지 않고 각도(0·90·180·270)만 기록 — 화면에 보일 때 기기에서 돌려서 표시
// openCropper({ src, crop, rotate, boxW, boxH }) → Promise<{ crop, rotate, mode, aspectPx } | { reset: true } | null>

/* 회전한 그림 주소 (같은 그림·각도는 한 번만 만듦) */
const rotCache = new Map();
export function rotatedURL(src, deg) {
  deg = ((deg % 360) + 360) % 360;
  if (!deg || !src) return Promise.resolve(src);
  const key = `${src}|${deg}`;
  if (!rotCache.has(key)) {
    rotCache.set(key, new Promise((resolve) => {
      const im = new Image();
      im.onload = () => {
        const c = document.createElement('canvas');
        const side = deg === 90 || deg === 270;
        c.width = side ? im.naturalHeight : im.naturalWidth;
        c.height = side ? im.naturalWidth : im.naturalHeight;
        const ctx = c.getContext('2d');
        ctx.translate(c.width / 2, c.height / 2);
        ctx.rotate((deg * Math.PI) / 180);
        ctx.drawImage(im, -im.naturalWidth / 2, -im.naturalHeight / 2);
        c.toBlob((b) => resolve(b ? URL.createObjectURL(b) : src), 'image/webp', 0.92);
      };
      im.onerror = () => resolve(src);
      im.src = src;
    }));
  }
  return rotCache.get(key);
}

const RATIOS = [
  { key: 'keep', label: '현재 크기 유지' },
  { key: 'free', label: '자유' },
  { key: '1:1', label: '1:1', r: 1 },
  { key: '4:3', label: '4:3', r: 4 / 3 },
  { key: '16:9', label: '16:9', r: 16 / 9 },
  { key: 'orig', label: '원본 비율' },
];
const HANDLES = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'];
const MIN = 0.04; // 최소 4%

export function openCropper({ src, crop, rotate = 0, boxW, boxH }) {
  return new Promise((resolve) => {
    const ov = document.createElement('div');
    ov.className = 'crop-ov';
    ov.innerHTML = `
      <div class="crop-bar">
        <div class="crop-ratios">${RATIOS.map((r) => `<button data-r="${r.key}">${r.label}</button>`).join('')}</div>
        <div class="crop-acts">
          <button data-act="rotl" title="왼쪽으로 90° 회전">⟲</button>
          <button data-act="rotr" title="오른쪽으로 90° 회전">⟳</button>
          <button data-act="reset" title="자르기 전 원본 그대로">↺ 원래대로</button>
          <button data-act="cancel">취소</button>
          <button data-act="apply" class="primary">적용</button>
        </div>
      </div>
      <div class="crop-area">
        <div class="crop-stage">
          <img alt="" draggable="false" />
          <div class="crop-shade"><i class="crop-hole"></i></div>
          <div class="crop-frame">${HANDLES.map((h) => `<span class="crop-h" data-h="${h}"></span>`).join('')}<i class="crop-grid"></i></div>
        </div>
      </div>
      <p class="crop-tip">틀의 모서리·변을 끌어 범위를 정하고, 틀 안쪽을 끌어 위치를 옮깁니다. Enter 적용 · Esc 취소</p>`;
    document.body.appendChild(ov);
    const stage = ov.querySelector('.crop-stage');
    const img = stage.querySelector('img');
    const frame = ov.querySelector('.crop-frame');
    const hole = ov.querySelector('.crop-hole');

    let f = crop ? { ...crop } : { x: 0, y: 0, w: 1, h: 1 };
    let rot = ((rotate % 360) + 360) % 360;
    let firstLoad = true;
    let mode = 'keep';
    let natW = 1;
    let natH = 1;

    // 틀의 비율(원본 픽셀 기준 가로/세로). null = 자유
    const targetAspect = () => {
      if (mode === 'free') return null;
      if (mode === 'keep') return boxW && boxH ? boxW / boxH : null;
      if (mode === 'orig') return natW / natH;
      return RATIOS.find((r) => r.key === mode).r;
    };
    // 비율값을 0~1 좌표계(가로/세로 크기가 다름)로 바꾼 값
    const fracAspect = () => {
      const a = targetAspect();
      return a ? a * (natH / natW) : null;
    };

    function draw() {
      frame.style.left = `${f.x * 100}%`;
      frame.style.top = `${f.y * 100}%`;
      frame.style.width = `${f.w * 100}%`;
      frame.style.height = `${f.h * 100}%`;
      Object.assign(hole.style, { left: frame.style.left, top: frame.style.top, width: frame.style.width, height: frame.style.height });
      ov.querySelectorAll('[data-r]').forEach((b) => b.classList.toggle('on', b.dataset.r === mode));
    }

    /** 고른 비율에 맞춰 지금 틀 안에서 가장 큰 틀로 (가운데 기준) */
    function fitToAspect() {
      const a = fracAspect();
      if (!a) return;
      const cx = f.x + f.w / 2;
      const cy = f.y + f.h / 2;
      let w = f.w;
      let h = w / a;
      if (h > f.h) { h = f.h; w = h * a; }
      if (w > 1) { w = 1; h = w / a; }
      if (h > 1) { h = 1; w = h * a; }
      f = { w, h, x: Math.min(Math.max(0, cx - w / 2), 1 - w), y: Math.min(Math.max(0, cy - h / 2), 1 - h) };
    }

    function layoutStage() {
      const area = ov.querySelector('.crop-area').getBoundingClientRect();
      const s = Math.min(area.width / natW, area.height / natH, 1.5);
      stage.style.width = `${natW * s}px`;
      stage.style.height = `${natH * s}px`;
    }

    img.onload = () => {
      natW = img.naturalWidth || 1;
      natH = img.naturalHeight || 1;
      layoutStage();
      if (firstLoad && !crop) fitToAspect(); // 처음 자를 때: 현재 그림 칸 비율의 가장 큰 틀
      firstLoad = false;
      draw();
    };
    const showRotated = () => rotatedURL(src, rot).then((u) => { img.src = u; });
    showRotated();

    /** 90° 회전: 틀도 함께 돌림 */
    function turn(cw) {
      rot = (rot + (cw ? 90 : 270)) % 360;
      f = cw ? { x: 1 - (f.y + f.h), y: f.x, w: f.h, h: f.w } : { x: f.y, y: 1 - (f.x + f.w), w: f.h, h: f.w };
      [natW, natH] = [natH, natW];
      fitToAspect();
      layoutStage();
      draw();
      showRotated();
    }
    window.addEventListener('resize', layoutStage);

    /* ── 끌기 ── */
    let drag = null;
    const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), hi);
    ov.addEventListener('pointerdown', (e) => {
      const h = e.target.closest('.crop-h');
      const inFrame = e.target.closest('.crop-frame');
      if (!h && !inFrame) return;
      e.preventDefault();
      const r = stage.getBoundingClientRect();
      drag = { dir: h ? h.dataset.h : 'move', x0: e.clientX, y0: e.clientY, f0: { ...f }, sw: r.width, sh: r.height, id: e.pointerId };
      try { e.target.setPointerCapture(e.pointerId); } catch { /* 무시 */ }
    });
    ov.addEventListener('pointermove', (e) => {
      if (!drag || e.pointerId !== drag.id) return;
      const dx = (e.clientX - drag.x0) / drag.sw;
      const dy = (e.clientY - drag.y0) / drag.sh;
      const o = drag.f0;
      if (drag.dir === 'move') {
        f = { ...o, x: clamp(o.x + dx, 0, 1 - o.w), y: clamp(o.y + dy, 0, 1 - o.h) };
        return draw();
      }
      const d = drag.dir;
      let x1 = o.x, y1 = o.y, x2 = o.x + o.w, y2 = o.y + o.h;
      if (d.includes('w')) x1 = clamp(o.x + dx, 0, x2 - MIN);
      if (d.includes('e')) x2 = clamp(x2 + dx, x1 + MIN, 1);
      if (d.includes('n')) y1 = clamp(o.y + dy, 0, y2 - MIN);
      if (d.includes('s')) y2 = clamp(y2 + dy, y1 + MIN, 1);
      const a = fracAspect();
      if (a) {
        // 비율 고정: 움직인 변을 기준으로 나머지 변을 맞춤 (반대편 모서리 고정)
        let w = x2 - x1;
        let h = y2 - y1;
        if (d === 'n' || d === 's') w = h * a;
        else if (d === 'e' || d === 'w') h = w / a;
        else if (w / h > a) h = w / a;
        else w = h * a;
        const ax = d.includes('w') ? x2 : d.includes('e') ? x1 : (x1 + x2) / 2;
        const ay = d.includes('n') ? y2 : d.includes('s') ? y1 : (y1 + y2) / 2;
        const maxW = d.includes('w') ? ax : d.includes('e') ? 1 - ax : 2 * Math.min(ax, 1 - ax);
        const maxH = d.includes('n') ? ay : d.includes('s') ? 1 - ay : 2 * Math.min(ay, 1 - ay);
        if (w > maxW) { w = maxW; h = w / a; }
        if (h > maxH) { h = maxH; w = h * a; }
        x1 = d.includes('w') ? ax - w : d.includes('e') ? ax : ax - w / 2;
        y1 = d.includes('n') ? ay - h : d.includes('s') ? ay : ay - h / 2;
        x2 = x1 + w;
        y2 = y1 + h;
      }
      f = { x: x1, y: y1, w: x2 - x1, h: y2 - y1 };
      draw();
    });
    const endDrag = () => { drag = null; };
    ov.addEventListener('pointerup', endDrag);
    ov.addEventListener('pointercancel', endDrag);

    /* ── 버튼·키 ── */
    function close(result) {
      window.removeEventListener('resize', layoutStage);
      document.removeEventListener('keydown', onKey, true);
      ov.remove();
      resolve(result);
    }
    function apply() {
      const full = f.x < 0.002 && f.y < 0.002 && f.w > 0.996 && f.h > 0.996;
      close({ crop: full ? null : f, rotate: rot, mode, aspectPx: (f.w * natW) / (f.h * natH), natAspect: natW / natH });
    }
    ov.addEventListener('click', (e) => {
      const r = e.target.closest('[data-r]');
      if (r) { mode = r.dataset.r; fitToAspect(); return draw(); }
      const act = e.target.closest('[data-act]')?.dataset.act;
      if (act === 'cancel') close(null);
      if (act === 'apply') apply();
      if (act === 'rotl') turn(false);
      if (act === 'rotr') turn(true);
      if (act === 'reset') close({ reset: true, natAspect: rot % 180 ? natH / natW : natW / natH });
    });
    function onKey(e) {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(null); }
      if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); apply(); }
    }
    document.addEventListener('keydown', onKey, true);
    draw();
  });
}
