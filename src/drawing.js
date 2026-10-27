// 필기 블록 — 텍스트 노트 안에 넣는 필압 펜 영역 (벡터 저장, 획 묶음 단위 기록)
import { Node, mergeAttributes } from '@tiptap/core';
import { putChunk, subscribeChunks, newId } from './store.js';
import { DEVICE_ID } from './device.js';
import {
  UNIT_W, A4_PAGE_H, PEN_COLORS, HL_COLORS, PEN_SIZES, HL_SIZE,
  encodePoints, decodePoints, strokePath, strokeBounds, hitStroke, drawBackground,
} from './ink.js';

const INFINITE_START = 600;
const INFINITE_STEP = 400;
const MIN_HEIGHT = 200; // 무한 종이의 최소 높이
const FLUSH_DELAY = 2000; // 펜을 2초 떼면 묶음 저장
const MAX_CHUNK_CHARS = 450_000; // 묶음 1건 약 500KB 이하
const PAPER_INK = { line: '#D6DCE4', page: '#9AA5B0' };


/* 도구 아이콘 (단순 선 그림) */
const svg = (d, w = 1.8) => `<svg viewBox="0 0 24 24" width="19" height="19" fill="none" stroke="currentColor" stroke-width="${w}" stroke-linecap="round" stroke-linejoin="round">${d}</svg>`;
const ICON = {
  pen: svg('<path d="M15.5 4.5l4 4L8 20l-4.7.7L4 16z"/><path d="M13.5 6.5l4 4"/>'),
  eraser: svg('<g transform="rotate(45 12 12)"><rect x="7.5" y="3" width="9" height="18" rx="2.2"/><path d="M7.5 15h9"/></g>'),
  marker: svg('<path d="M14 3.5l6.5 6.5-7 7-6.5-6.5z"/><path d="M7 10.5l6.5 6.5-2.5 2.5H7.5L5 17z"/><path d="M5 17l-2 3.5h5"/>'),
  move: svg('<path d="M12 3v18M3 12h18"/><path d="M9 6l3-3 3 3M9 18l3 3 3-3M6 9l-3 3 3 3M18 9l3 3-3 3"/>'),
  grow: svg('<path d="M12 3.5v12M6.5 10l5.5 5.5 5.5-5.5M4.5 20.5h15"/>', 2.8),
  shrink: svg('<path d="M12 20.5v-12M6.5 14l5.5-5.5 5.5 5.5M4.5 3.5h15"/>', 2.8),
};

/* 여러 블록이 공유하는 도구 상태 */
const ink = { tool: 'pen', color: PEN_COLORS[0], hlColor: HL_COLORS[0], size: 'normal' };
let penSeen = false; // 펜 입력이 한 번이라도 있었으면 손가락은 화면 이동 전용
let activeView = null;
const views = new Map(); // drawingId → view

export const getDrawingView = (id) => views.get(id);
export const flushAllDrawings = () => Promise.all([...views.values()].map((v) => v.flush()));

window.addEventListener('pointerdown', (e) => {
  if (activeView && !activeView.dom.contains(e.target)) activeView.deactivate();
}, true);

window.addEventListener('keydown', (e) => {
  if (!activeView) return;
  const mod = e.ctrlKey || e.metaKey;
  if (mod && e.key.toLowerCase() === 'z' && !e.shiftKey) { e.preventDefault(); e.stopPropagation(); activeView.undo(); }
  else if (mod && (e.key.toLowerCase() === 'y' || (e.key.toLowerCase() === 'z' && e.shiftKey))) { e.preventDefault(); e.stopPropagation(); activeView.redo(); }
  else if (e.key === 'Escape') activeView.deactivate();
}, true);

class DrawingView {
  constructor({ node, editor, getPos }, options) {
    this.node = node;
    this.editor = editor;
    this.getPos = getPos;
    this.options = options;
    this.strokes = new Map();
    this.pending = new Map(); // 획 ID → { rec } 또는 { erase: true } (묶음 안에서 최종 상태만 기록)
    this.undoStack = [];
    this.redoStack = [];
    this.seq = 0;
    this.current = null;
    this.scale = 1;
    this.noteId = options.getNoteId(); // 노트 전환 후 저장돼도 원래 노트로 기록
    this.buildDom();
    views.set(node.attrs.drawingId, this);
    this.load();
  }

  /* ───── 화면 구성 ───── */
  buildDom() {
    const dom = document.createElement('div');
    dom.className = 'drawing-block';
    dom.contentEditable = 'false';
    dom.innerHTML = `
      <div class="ink-bar">
        <div class="ink-group">
          <button data-ink-tool="pen" title="펜">${ICON.pen}</button>
          <button data-ink-tool="eraser" title="지우개 — 닿은 획을 통째로 지움 (펜 옆 버튼을 누른 채 써도 지우개)">${ICON.eraser}</button>
          <button data-ink-tool="highlighter" title="형광펜">${ICON.marker}</button>
          <button data-ink-tool="hand" title="화면 이동 (손가락으로 넘기기)">${ICON.move}</button>
        </div>
        <span class="ink-sep"></span>
        <button class="ink-dd" data-ink-dd="color" title="색상"><i class="dd-swatch"></i><span class="dd-caret">▾</span></button>
        <button class="ink-dd" data-ink-dd="size" title="굵기"><i class="dd-dot"></i><span class="dd-caret">▾</span></button>
        <select class="ink-bg" title="배경">
          <option value="lined">줄노트</option>
          <option value="blank">무지</option>
          <option value="grid">모눈</option>
        </select>
        <span class="ink-sep"></span>
        <button data-ink-act="undo" title="실행 취소 (Ctrl+Z)">↶</button>
        <button data-ink-act="redo" title="다시 실행 (Ctrl+Y)">↷</button>
        <button data-ink-act="shrink" class="ink-bold">${ICON.shrink}</button>
        <button data-ink-act="grow" class="ink-bold">${ICON.grow}</button>
        <button data-ink-act="up" title="필기 블록을 위로 이동 (위 문단과 자리 바꿈)">▲</button>
        <button data-ink-act="down" title="필기 블록을 아래로 이동 (아래 문단과 자리 바꿈)">▼</button>
        <button data-ink-act="done" class="ink-done">완료</button>
      </div>
      <div class="ink-pop" hidden></div>
      <div class="ink-stage">
        <canvas class="ink-base"></canvas>
        <canvas class="ink-live"></canvas>
        <div class="ink-hint">필기 영역 · 눌러서 쓰기</div>
      </div>`;
    this.dom = dom;
    this.bar = dom.querySelector('.ink-bar');
    this.stage = dom.querySelector('.ink-stage');
    this.base = dom.querySelector('.ink-base');
    this.live = dom.querySelector('.ink-live');
    this.bgSel = dom.querySelector('.ink-bg');

    this.bar.addEventListener('pointerdown', (e) => e.stopPropagation());
    this.bar.addEventListener('click', (e) => this.onBarClick(e));
    const pop = dom.querySelector('.ink-pop');
    pop.addEventListener('pointerdown', (e) => e.stopPropagation());
    pop.addEventListener('click', (e) => this.onBarClick(e));
    this.bgSel.addEventListener('change', () => this.setAttrs({ background: this.bgSel.value }));

    const live = this.live;
    live.addEventListener('pointerdown', (e) => this.onDown(e));
    live.addEventListener('pointermove', (e) => this.onMove(e));
    live.addEventListener('pointerup', (e) => this.onUp(e));
    live.addEventListener('pointercancel', (e) => this.onUp(e, true));
    live.addEventListener('contextmenu', (e) => e.preventDefault());

    this.ro = new ResizeObserver(() => this.layout());
    this.ro.observe(this.stage);
    this.renderBar();
  }

  renderBar() {
    const isHl = ink.tool === 'highlighter';
    const cur = isHl ? ink.hlColor : ink.color;
    this.bar.querySelectorAll('[data-ink-tool]').forEach((b) => b.classList.toggle('on', b.dataset.inkTool === ink.tool));
    const colorBtn = this.bar.querySelector('[data-ink-dd="color"]');
    const sizeBtn = this.bar.querySelector('[data-ink-dd="size"]');
    colorBtn.querySelector('.dd-swatch').style.background = cur;
    sizeBtn.querySelector('.dd-dot').dataset.size = ink.size;
    const noColor = ink.tool === 'eraser' || ink.tool === 'hand';
    colorBtn.hidden = noColor;
    sizeBtn.hidden = noColor || isHl;
    this.bgSel.value = this.node.attrs.background;
    const a4 = this.node.attrs.paper === 'a4';
    const growBtn = this.bar.querySelector('[data-ink-act="grow"]');
    const shrinkBtn = this.bar.querySelector('[data-ink-act="shrink"]');
    growBtn.title = a4 ? 'A4 쪽 추가' : '필기 영역 늘리기';
    shrinkBtn.title = a4 ? '마지막 쪽 삭제 (빈 쪽만)' : '필기 영역 줄이기 (아래쪽 빈 공간만)';
    shrinkBtn.disabled = this.shrinkTarget() === null;
    this.stage.classList.toggle('eraser', ink.tool === 'eraser');
    this.stage.classList.toggle('hand', ink.tool === 'hand');
  }

  /** 색상·굵기 선택 상자 */
  openPop(kind, btn) {
    const pop = this.dom.querySelector('.ink-pop');
    if (!pop.hidden && pop.dataset.kind === kind) { pop.hidden = true; return; }
    const isHl = ink.tool === 'highlighter';
    if (kind === 'color') {
      const cur = isHl ? ink.hlColor : ink.color;
      pop.innerHTML = (isHl ? HL_COLORS : PEN_COLORS)
        .map((c) => `<button data-ink-color="${c}" class="swatch ${c === cur ? 'on' : ''}" style="--c:${c}" title="색상"></button>`).join('');
    } else {
      pop.innerHTML = ['thin', 'normal', 'thick']
        .map((k) => `<button data-ink-size="${k}" class="size-opt ${k === ink.size ? 'on' : ''}" title="${{ thin: '가늘게', normal: '보통', thick: '굵게' }[k]}"><i class="dd-dot" data-size="${k}"></i></button>`).join('');
    }
    pop.dataset.kind = kind;
    const r = btn.getBoundingClientRect();
    const host = this.dom.getBoundingClientRect();
    pop.style.left = `${Math.max(4, r.left - host.left)}px`;
    pop.style.top = `${r.bottom - host.top + 4}px`;
    pop.hidden = false;
  }

  onBarClick(e) {
    const b = e.target.closest('button');
    if (!b) return;
    if (b.dataset.inkDd) return this.openPop(b.dataset.inkDd, b);
    this.dom.querySelector('.ink-pop').hidden = true;
    if (b.dataset.inkTool) ink.tool = b.dataset.inkTool;
    if (b.dataset.inkColor) {
      if (ink.tool === 'highlighter') ink.hlColor = b.dataset.inkColor;
      else ink.color = b.dataset.inkColor;
    }
    if (b.dataset.inkSize) ink.size = b.dataset.inkSize;
    const act = b.dataset.inkAct;
    if (act === 'undo') this.undo();
    if (act === 'redo') this.redo();
    if (act === 'grow') this.grow();
    if (act === 'shrink') this.shrink();
    if (act === 'up') return this.moveBlock(-1);
    if (act === 'down') return this.moveBlock(1);
    if (act === 'done') return this.deactivate();
    views.forEach((v) => v.renderBar());
  }

  /* ───── 크기·그리기 ───── */
  get heightUnits() {
    return this.node.attrs.height;
  }

  layout() {
    const w = this.stage.clientWidth;
    if (!w) return;
    this.scale = w / UNIT_W;
    const h = Math.round(this.heightUnits * this.scale);
    this.stage.style.height = `${h}px`;
    const dpr = window.devicePixelRatio || 1;
    for (const c of [this.base, this.live]) {
      c.width = Math.round(w * dpr);
      c.height = Math.round(h * dpr);
      c.style.width = `${w}px`;
      c.style.height = `${h}px`;
    }
    this.ratio = dpr * this.scale;
    this.redraw();
  }

  ctx(canvas) {
    const ctx = canvas.getContext('2d');
    ctx.setTransform(this.ratio, 0, 0, this.ratio, 0, 0);
    return ctx;
  }

  paintStroke(ctx, s) {
    ctx.save();
    if (s.tool === 'highlighter') {
      ctx.globalAlpha = 0.5;
      ctx.globalCompositeOperation = 'multiply';
    }
    ctx.fillStyle = s.color;
    ctx.fill(s.path);
    ctx.restore();
  }

  redraw() {
    if (!this.ratio) return;
    const ctx = this.ctx(this.base);
    ctx.clearRect(0, 0, UNIT_W, this.heightUnits);
    drawBackground(ctx, this.node.attrs.background, this.heightUnits, this.node.attrs.paper, PAPER_INK);
    // 형광펜을 먼저 깔고 펜 획을 위에
    for (const s of this.strokes.values()) if (s.tool === 'highlighter') this.paintStroke(ctx, s);
    for (const s of this.strokes.values()) if (s.tool !== 'highlighter') this.paintStroke(ctx, s);
    this.dom.classList.toggle('has-ink', this.strokes.size > 0);
    const sb = this.bar?.querySelector('[data-ink-act="shrink"]');
    if (sb) sb.disabled = this.shrinkTarget() === null;
  }

  /* ───── 기록 불러오기 ───── */
  hydrate(rec) {
    const points = decodePoints(rec.pts);
    const s = { ...rec, points };
    s.bounds = strokeBounds(s);
    s.path = strokePath(s);
    return s;
  }

  /** 묶음 구독: 처음엔 전체를, 이후엔 다른 기기에서 새로 쓴 묶음을 받아 반영 */
  load() {
    this.applied = new Set();
    this.unsub = subscribeChunks(this.node.attrs.drawingId, (chunks) => {
      let changed = false;
      for (const ch of chunks) {
        if (this.applied.has(ch.id)) continue;
        this.applied.add(ch.id);
        for (const rec of ch.strokes || []) this.strokes.set(rec.id, this.hydrate(rec));
        for (const id of ch.erased || []) this.strokes.delete(id);
        if (ch.device === DEVICE_ID) this.seq = Math.max(this.seq, ch.seq || 0);
        changed = true;
      }
      if (changed) this.redraw();
    });
  }

  /* ───── 활성화 ───── */
  activate() {
    if (activeView === this) return;
    if (activeView) activeView.deactivate();
    activeView = this;
    this.dom.classList.add('active');
    this.renderBar();
  }

  deactivate() {
    if (activeView !== this) return;
    this.dom.querySelector('.ink-pop').hidden = true;
    activeView = null;
    this.dom.classList.remove('active');
    this.flush();
  }

  /* ───── 입력 처리 ───── */
  toUnits(e) {
    const r = this.live.getBoundingClientRect();
    return [(e.clientX - r.left) / this.scale, (e.clientY - r.top) / this.scale];
  }

  onDown(e) {
    if (!this.editor.isEditable) return; // 휴지통 노트는 읽기 전용
    if (e.pointerType === 'pen') penSeen = true;
    if (!this.dom.classList.contains('active')) {
      this.activate();
      if (e.pointerType !== 'pen') return; // 손가락·마우스는 첫 탭으로 활성화만
    }
    if (this.current) return; // 다른 손가락·손바닥 무시
    if ((e.pointerType === 'touch' && penSeen) || (ink.tool === 'hand' && e.pointerType !== 'pen')) {
      // 펜 사용 기기: 손가락은 화면 이동
      this.panning = { id: e.pointerId, y: e.clientY, wrap: this.dom.closest('.editor-wrap') };
      try { this.live.setPointerCapture(e.pointerId); } catch { /* 무시 */ }
      return;
    }
    e.preventDefault();
    try { this.live.setPointerCapture(e.pointerId); } catch { /* 무시 */ }
    const [x, y] = this.toUnits(e);
    // 펜 뒤쪽 지우개(eraser 버튼) 또는 펜 옆 버튼을 누른 채 쓰면 임시 지우개
    const penEraser = e.pointerType === 'pen' && ((e.buttons & 32) || (e.buttons & 2) || e.button === 5 || e.button === 2);
    if (ink.tool === 'eraser' || penEraser) {
      this.current = { id: e.pointerId, eraser: true, removed: [] };
      this.eraseAt(x, y);
      return;
    }
    const isHl = ink.tool === 'highlighter';
    this.current = {
      id: e.pointerId,
      t0: e.timeStamp,
      stroke: {
        id: newId('s'),
        tool: ink.tool,
        color: isHl ? ink.hlColor : ink.color,
        size: isHl ? HL_SIZE : PEN_SIZES[ink.size],
        pressure: e.pointerType === 'pen' ? 1 : 0,
        points: [[x, y, e.pointerType === 'pen' ? e.pressure : 0.5, 0]],
      },
    };
    this.drawLive();
  }

  onMove(e) {
    if (this.panning && e.pointerId === this.panning.id) {
      const dy = e.clientY - this.panning.y;
      this.panning.y = e.clientY;
      if (this.panning.wrap) this.panning.wrap.scrollTop -= dy;
      return;
    }
    const cur = this.current;
    if (!cur || e.pointerId !== cur.id) return;
    const events = e.getCoalescedEvents ? e.getCoalescedEvents() : [e];
    for (const ev of events.length ? events : [e]) {
      const [x, y] = this.toUnits(ev);
      if (cur.eraser) this.eraseAt(x, y);
      else cur.stroke.points.push([x, y, ev.pointerType === 'pen' ? ev.pressure : 0.5, ev.timeStamp - cur.t0]);
    }
    if (!cur.eraser) this.drawLive();
  }

  onUp(e, cancelled = false) {
    if (this.panning && e.pointerId === this.panning.id) { this.panning = null; return; }
    const cur = this.current;
    if (!cur || e.pointerId !== cur.id) return;
    this.current = null;
    this.ctx(this.live).clearRect(0, 0, UNIT_W, this.heightUnits);
    if (cur.eraser) {
      if (cur.removed.length) this.commit({ type: 'erase', strokes: cur.removed });
      return;
    }
    if (cancelled && cur.stroke.points.length < 3) return;
    const s = cur.stroke;
    s.bounds = strokeBounds(s);
    s.path = strokePath(s);
    this.strokes.set(s.id, s);
    this.paintStroke(this.ctx(this.base), s);
    this.dom.classList.add('has-ink');
    this.commit({ type: 'add', strokes: [s] });
    this.autoGrow(s.bounds.maxY);
    this.renderBar();
  }

  drawLive() {
    const ctx = this.ctx(this.live);
    ctx.clearRect(0, 0, UNIT_W, this.heightUnits);
    const s = this.current.stroke;
    this.paintStroke(ctx, { ...s, path: strokePath(s) });
  }

  eraseAt(x, y) {
    const r = 8;
    let hit = false;
    for (const s of this.strokes.values()) {
      if (hitStroke(s, x, y, r)) {
        this.strokes.delete(s.id);
        this.current.removed.push(s);
        hit = true;
      }
    }
    if (hit) this.redraw();
  }

  /* ───── 기록·실행 취소 ───── */
  toRecord(s) {
    return { id: s.id, tool: s.tool, color: s.color, size: s.size, pressure: s.pressure, pts: encodePoints(s.points) };
  }

  commit(op, fromHistory = false) {
    for (const s of op.strokes) {
      this.pending.set(s.id, op.type === 'add' ? { rec: this.toRecord(s) } : { erase: true });
    }
    if (!fromHistory) {
      this.undoStack.push(op);
      this.redoStack.length = 0;
    }
    clearTimeout(this.flushTimer);
    this.flushTimer = setTimeout(() => this.flush(), FLUSH_DELAY);
  }

  apply(op, reverse) {
    const adding = (op.type === 'add') !== reverse;
    for (const s of op.strokes) {
      if (adding) this.strokes.set(s.id, s);
      else this.strokes.delete(s.id);
    }
    this.commit({ type: adding ? 'add' : 'erase', strokes: op.strokes }, true);
    this.redraw();
  }

  undo() {
    const op = this.undoStack.pop();
    if (!op) return;
    this.apply(op, true);
    this.redoStack.push(op);
  }

  redo() {
    const op = this.redoStack.pop();
    if (!op) return;
    this.apply(op, false);
    this.undoStack.push(op);
  }

  async flush() {
    clearTimeout(this.flushTimer);
    if (!this.pending.size) return;
    const strokes = [];
    const erased = [];
    for (const [id, v] of this.pending) {
      if (v.rec) strokes.push(v.rec);
      else erased.push(id);
    }
    this.pending = new Map();
    // 묶음 1건이 너무 크지 않도록 나눠 저장
    const batches = [];
    let cur = { strokes: [], erased, chars: 0 };
    for (const rec of strokes) {
      const len = rec.pts.length + 80;
      if (cur.chars + len > MAX_CHUNK_CHARS && cur.strokes.length) {
        batches.push(cur);
        cur = { strokes: [], erased: [], chars: 0 };
      }
      cur.strokes.push(rec);
      cur.chars += len;
    }
    batches.push(cur);
    for (const b of batches) {
      this.seq += 1;
      const id = `${this.node.attrs.drawingId}_${DEVICE_ID}_${String(this.seq).padStart(5, '0')}_${Date.now().toString(36)}`;
      this.applied?.add(id); // 내가 쓴 묶음은 다시 적용하지 않음
      putChunk({
        id,
        drawingId: this.node.attrs.drawingId,
        noteId: this.noteId,
        device: DEVICE_ID,
        seq: this.seq,
        strokes: b.strokes,
        erased: b.erased,
        createdAt: Date.now(),
      });
    }
    this.options.onInk?.();
  }

  /* ───── 블록 위치 이동 (위·아래 문단과 자리 바꿈) ───── */
  async moveBlock(dir) {
    const pos = this.getPos();
    if (typeof pos !== 'number') return;
    const { state } = this.editor.view;
    const node = state.doc.nodeAt(pos);
    const $p = state.doc.resolve(pos);
    const idx = $p.index();
    const parent = $p.parent;
    let tr;
    if (dir < 0) {
      if (idx === 0) return;
      const prev = parent.child(idx - 1);
      tr = state.tr.delete(pos, pos + node.nodeSize).insert(pos - prev.nodeSize, node);
    } else {
      if (idx >= parent.childCount - 1) return;
      const next = parent.child(idx + 1);
      tr = state.tr.delete(pos, pos + node.nodeSize).insert(pos + next.nodeSize, node);
    }
    await this.flush(); // 옮기는 동안 쓰던 획을 먼저 저장
    const id = this.node.attrs.drawingId;
    this.editor.view.dispatch(tr);
    // 자리를 옮기면 블록이 새로 그려지므로 다시 활성화하고 화면에 보이게
    setTimeout(() => {
      const v = views.get(id);
      if (!v) return;
      v.activate();
      v.dom.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    }, 0);
  }

  /* ───── 영역 크기 ───── */
  setAttrs(attrs) {
    const pos = this.getPos();
    if (typeof pos !== 'number') return;
    const tr = this.editor.view.state.tr.setNodeMarkup(pos, undefined, { ...this.node.attrs, ...attrs });
    tr.setMeta('addToHistory', false);
    this.editor.view.dispatch(tr);
  }

  grow() {
    const step = this.node.attrs.paper === 'a4' ? A4_PAGE_H : INFINITE_STEP;
    this.setAttrs({ height: this.heightUnits + step });
  }

  /** 줄일 수 있는 높이 (필기가 있는 곳 아래 빈 공간만 줄임). 줄일 수 없으면 null */
  shrinkTarget() {
    const h = this.heightUnits;
    let maxY = 0;
    for (const s of this.strokes.values()) maxY = Math.max(maxY, s.bounds.maxY);
    if (this.node.attrs.paper === 'a4') {
      const next = h - A4_PAGE_H;
      return next >= A4_PAGE_H && maxY <= next ? next : null;
    }
    const floor = Math.max(MIN_HEIGHT, Math.ceil(maxY + 40));
    const next = Math.max(floor, h - INFINITE_STEP);
    return next < h ? next : null;
  }

  shrink() {
    const next = this.shrinkTarget();
    if (next !== null) this.setAttrs({ height: next });
  }

  autoGrow(maxY) {
    const margin = this.node.attrs.paper === 'a4' ? 120 : 160;
    if (maxY > this.heightUnits - margin) this.grow();
  }

  /* ───── ProseMirror 연동 ───── */
  update(node) {
    if (node.type !== this.node.type || node.attrs.drawingId !== this.node.attrs.drawingId) return false;
    const old = this.node.attrs;
    this.node = node;
    if (old.height !== node.attrs.height) this.layout();
    else if (old.background !== node.attrs.background || old.paper !== node.attrs.paper) this.redraw();
    this.renderBar();
    return true;
  }

  stopEvent() {
    return true;
  }

  ignoreMutation() {
    return true;
  }

  destroy() {
    this.flush();
    this.unsub?.();
    this.ro.disconnect();
    if (activeView === this) activeView = null;
    if (views.get(this.node.attrs.drawingId) === this) views.delete(this.node.attrs.drawingId);
  }
}

export const Drawing = Node.create({
  name: 'drawing',
  group: 'block',
  atom: true,
  selectable: true,
  draggable: false,

  addOptions() {
    return { getNoteId: () => null, onInk: null };
  },

  addAttributes() {
    const attr = (key, html, def, num = false) => ({
      default: def,
      parseHTML: (el) => {
        const v = el.getAttribute(`data-${html}`);
        return v == null ? def : num ? Number(v) : v;
      },
      renderHTML: (a) => ({ [`data-${html}`]: a[key] }),
    });
    return {
      drawingId: attr('drawingId', 'drawing-id', null),
      height: attr('height', 'height', INFINITE_START, true),
      background: attr('background', 'background', 'lined'),
      paper: attr('paper', 'paper', 'infinite'),
    };
  },

  parseHTML() {
    return [{ tag: 'div[data-type="drawing"]' }];
  },

  renderHTML({ HTMLAttributes }) {
    return ['div', mergeAttributes(HTMLAttributes, { 'data-type': 'drawing' })];
  },

  renderText() {
    return '[필기]';
  },

  addNodeView() {
    return (props) => new DrawingView(props, this.options);
  },
});

/** 새 필기 블록 속성 */
export function newDrawingAttrs(settings) {
  const paper = settings.paper === 'a4' ? 'a4' : 'infinite';
  return {
    drawingId: newId('drw'),
    height: paper === 'a4' ? A4_PAGE_H : INFINITE_START,
    background: settings.background || 'lined',
    paper,
  };
}
