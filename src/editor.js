// Tiptap 편집기 — 폰트·크기, 체크박스, 형광펜, 그림 붙여넣기
import { Editor, Extension, textInputRule } from '@tiptap/core';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';
import StarterKit from '@tiptap/starter-kit';
import { TextStyle, FontFamily, FontSize, Color } from '@tiptap/extension-text-style';
import Highlight from '@tiptap/extension-highlight';
import { TaskList, TaskItem } from '@tiptap/extension-list';
import Image from '@tiptap/extension-image';
import { Placeholder } from '@tiptap/extensions';
import { compressImage } from './image.js';
import { Drawing, drawingFromImage, activateDrawing } from './drawing.js';
import { openCropper, rotatedURL } from './crop.js';
import { putImage, getImage, newId } from './store.js';

export const FONTS = [
  { label: 'Pretendard', value: '' }, // 기본값
  { label: '본고딕', value: '"Noto Sans KR"' },
  { label: '본명조', value: '"Noto Serif KR"' },
  { label: '나눔고딕', value: '"Nanum Gothic"' },
  { label: '나눔명조', value: '"Nanum Myeongjo"' },
  { label: '나눔손글씨 펜', value: '"Nanum Pen Script"' },
  { label: '고운돋움', value: '"Gowun Dodum"' },
];
export const SIZES = ['12px', '14px', '16px', '18px', '20px', '24px', '28px', '32px'];
/* 글자색: 다크 모드에서는 읽기 쉽도록 밝은 톤으로 바꿔 보여 줌(저장값은 그대로) */
export const TEXT_COLORS = [
  { label: '검정', color: '#111111' },
  { label: '군청', color: '#1F3A93' },
  { label: '빨강', color: '#D32F2F' },
];
export const HIGHLIGHTS = [
  { label: '노랑', color: '#FFF176' },
  { label: '연두', color: '#C5E1A5' },
  { label: '분홍', color: '#F8BBD0' },
  { label: '하늘', color: '#B3E5FC' },
];

/* ── 그림: imageId로 저장하고, 화면 표시용 주소(src)는 열 때마다 새로 만듦 ── */
const urlCache = new Map(); // imageId → object URL

async function urlFor(imageId) {
  if (urlCache.has(imageId)) return urlCache.get(imageId);
  const rec = await getImage(imageId);
  if (!rec) return '';
  const url = URL.createObjectURL(rec.blob);
  urlCache.set(imageId, url);
  return url;
}

/* ── 그림 크기 조절 ──
   모서리 4곳: 가로세로 비율 유지 (노트 폭을 넘지 않음)
   변 4곳: 좌우 변은 가로만, 위아래 변은 세로만 */
const HANDLES = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'];
class ImageView {
  constructor({ node, editor, getPos }) {
    this.node = node;
    this.editor = editor;
    this.getPos = getPos;
    const dom = document.createElement('div');
    dom.className = 'img-block';
    dom.contentEditable = 'false';
    dom.innerHTML = `<div class="img-wrap"><div class="img-clip"><img alt="" draggable="false" /></div>${HANDLES.map((h) => `<span class="img-h" data-h="${h}"></span>`).join('')}<div class="img-menu"><button data-im="crop" title="자르기·회전 (원본은 그대로 보관)">✂</button><button data-im="reset" title="원래대로 (자르기·회전 취소)">↺</button><button data-im="ink" title="그림 위에 필기">✒</button></div></div>`;
    this.dom = dom;
    this.wrap = dom.querySelector('.img-wrap');
    this.clip = dom.querySelector('.img-clip');
    this.img = dom.querySelector('img');
    this.render();
    dom.querySelectorAll('.img-h').forEach((h) => h.addEventListener('pointerdown', (e) => this.start(e, h.dataset.h)));
    dom.querySelector('.img-menu').addEventListener('pointerdown', (e) => { e.preventDefault(); e.stopPropagation(); });
    dom.querySelector('.img-menu').addEventListener('click', (e) => {
      const act = e.target.closest('[data-im]')?.dataset.im;
      if (act === 'crop') this.openCrop();
      if (act === 'reset') this.resetCrop();
      if (act === 'ink') this.toDrawing();
    });
    this.img.addEventListener('dblclick', () => this.openCrop());
  }

  get crop() {
    const { cropX: x, cropY: y, cropW: w, cropH: h } = this.node.attrs;
    return w && h ? { x, y, w, h } : null;
  }

  render() {
    const { src, width, height, rotate } = this.node.attrs;
    const want = `${src}|${rotate || 0}`;
    if (this.shown !== want) {
      this.shown = want;
      rotatedURL(src, rotate || 0).then((u) => { if (this.shown === want) this.img.setAttribute('src', u || ''); });
    }
    const c = this.crop;
    this.dom.classList.toggle('edited', !!c || !!rotate);
    // 폭은 노트 폭을 넘지 않게, 비율은 aspect-ratio로 유지 (좁은 화면에서도 모양 그대로)
    this.wrap.style.width = width ? `${width}px` : '';
    this.clip.style.aspectRatio = width && height ? `${width} / ${height}` : '';
    this.clip.classList.toggle('sized', !!(width && height));
    // 자르기: 원본을 확대·이동해 보여 줄 영역만 칸에 맞춤
    const s = this.img.style;
    if (c) {
      s.width = `${100 / c.w}%`;
      s.height = `${100 / c.h}%`;
      s.left = `${(-c.x / c.w) * 100}%`;
      s.top = `${(-c.y / c.h) * 100}%`;
    } else {
      s.width = s.height = s.left = s.top = '';
    }
  }

  async openCrop() {
    if (!this.editor.isEditable) return;
    const boxW = this.clip.offsetWidth;
    const boxH = this.clip.offsetHeight;
    const res = await openCropper({ src: this.node.attrs.src, crop: this.crop, rotate: this.node.attrs.rotate || 0, boxW, boxH });
    if (!res) return;
    if (res.reset) return this.resetCrop(res.natAspect);
    const W = this.node.attrs.width || boxW;
    const H = res.mode === 'keep' ? (this.node.attrs.height || boxH) : W / res.aspectPx;
    const c = res.crop;
    this.setAttrs({
      rotate: res.rotate || 0,
      cropX: c ? c.x : null, cropY: c ? c.y : null, cropW: c ? c.w : null, cropH: c ? c.h : null,
      width: Math.round(W), height: Math.round(H),
    });
  }

  resetCrop(natAspect) {
    const W = this.node.attrs.width || this.clip.offsetWidth;
    let aspect = natAspect;
    if (!aspect) {
      // 원본 비율: 회전 전 그림 크기 기준
      const n = this.img.naturalWidth && this.img.naturalHeight ? this.img.naturalWidth / this.img.naturalHeight : null;
      aspect = n && (this.node.attrs.rotate || 0) % 180 ? 1 / n : n;
    }
    this.setAttrs({ rotate: 0, cropX: null, cropY: null, cropW: null, cropH: null, width: Math.round(W), height: aspect ? Math.round(W / aspect) : null });
  }

  /** 이 그림을 '그림 위 필기' 블록으로 바꿈 (보이는 크기·자르기·회전 그대로, 실행 취소로 되돌릴 수 있음) */
  toDrawing() {
    if (!this.editor.isEditable || !this.node.attrs.imageId) return;
    const pos = this.getPos();
    if (typeof pos !== 'number') return;
    const w = this.clip.offsetWidth;
    const h = this.clip.offsetHeight;
    const full = this.dom.parentElement?.clientWidth || w;
    if (!w || !h) return;
    const attrs = drawingFromImage(this.node.attrs, w / full, w / h);
    const { state } = this.editor.view;
    const node = state.schema.nodes.drawing.create(attrs);
    this.editor.view.dispatch(state.tr.replaceWith(pos, pos + this.node.nodeSize, node));
    activateDrawing(attrs.drawingId);
  }

  setAttrs(attrs) {
    const pos = this.getPos();
    if (typeof pos !== 'number') return;
    this.editor.view.dispatch(this.editor.view.state.tr.setNodeMarkup(pos, undefined, { ...this.node.attrs, ...attrs }));
  }

  start(e, dir) {
    if (!this.editor.isEditable) return;
    e.preventDefault();
    e.stopPropagation();
    const h = e.currentTarget;
    try { h.setPointerCapture(e.pointerId); } catch { /* 무시 */ }
    const w0 = this.clip.offsetWidth;
    const h0 = this.clip.offsetHeight;
    const maxW = this.dom.parentElement?.clientWidth || w0;
    const x0 = e.clientX;
    const y0 = e.clientY;
    const ratio = w0 / h0;
    let w = w0;
    let ht = h0;
    this.dom.classList.add('resizing');
    this.clip.classList.add('sized');
    const zf = this.dom.currentCSSZoom || 1; // 노트 배율: 화면 이동량 → 그림 크기 단위
    const move = (ev) => {
      const dx = (ev.clientX - x0) / zf;
      const dy = (ev.clientY - y0) / zf;
      const sx = dir.includes('w') ? -dx : dir.includes('e') ? dx : 0;
      const sy = dir.includes('n') ? -dy : dir.includes('s') ? dy : 0;
      if (dir.length === 2) {
        // 모서리: 더 많이 움직인 쪽 기준으로 같은 비율로
        const grow = Math.abs(sx) >= Math.abs(sy * ratio) ? sx : sy * ratio;
        w = Math.max(60, Math.min(maxW, w0 + grow));
        ht = w / ratio;
      } else if (sx) {
        w = Math.max(40, Math.min(maxW, w0 + sx));
        ht = h0;
      } else {
        w = w0;
        ht = Math.max(40, Math.min(4000, h0 + sy));
      }
      this.wrap.style.width = `${w}px`;
      this.clip.style.aspectRatio = `${w} / ${ht}`;
    };
    const up = () => {
      h.removeEventListener('pointermove', move);
      h.removeEventListener('pointerup', up);
      h.removeEventListener('pointercancel', up);
      this.dom.classList.remove('resizing');
      this.setAttrs({ width: Math.round(w), height: Math.round(ht) });
    };
    h.addEventListener('pointermove', move);
    h.addEventListener('pointerup', up);
    h.addEventListener('pointercancel', up);
  }

  update(node) {
    if (node.type !== this.node.type) return false;
    this.node = node;
    this.render();
    return true;
  }

  selectNode() { this.dom.classList.add('selected'); }
  deselectNode() { this.dom.classList.remove('selected'); }
  stopEvent(e) { return !!e.target.closest?.('.img-h, .img-menu'); }
  ignoreMutation() { return true; }
}

const NoteImage = Image.extend({
  addNodeView() {
    return (props) => new ImageView(props);
  },
  addAttributes() {
    return {
      ...this.parent?.(),
      cropX: { default: null, parseHTML: (el) => (el.getAttribute('data-cropx') == null ? null : Number(el.getAttribute('data-cropx'))), renderHTML: (a) => (a.cropX == null ? {} : { 'data-cropx': a.cropX }) },
      cropY: { default: null, parseHTML: (el) => (el.getAttribute('data-cropy') == null ? null : Number(el.getAttribute('data-cropy'))), renderHTML: (a) => (a.cropY == null ? {} : { 'data-cropy': a.cropY }) },
      cropW: { default: null, parseHTML: (el) => (el.getAttribute('data-cropw') == null ? null : Number(el.getAttribute('data-cropw'))), renderHTML: (a) => (a.cropW == null ? {} : { 'data-cropw': a.cropW }) },
      cropH: { default: null, parseHTML: (el) => (el.getAttribute('data-croph') == null ? null : Number(el.getAttribute('data-croph'))), renderHTML: (a) => (a.cropH == null ? {} : { 'data-croph': a.cropH }) },
      rotate: { default: null, parseHTML: (el) => (el.getAttribute('data-rotate') == null ? null : Number(el.getAttribute('data-rotate'))), renderHTML: (a) => (a.rotate == null ? {} : { 'data-rotate': a.rotate }) },
      imageId: {
        default: null,
        parseHTML: (el) => el.getAttribute('data-image-id'),
        renderHTML: (attrs) => (attrs.imageId ? { 'data-image-id': attrs.imageId } : {}),
      },
    };
  },
});

/** 저장용 JSON: 기기 내 임시 주소(blob:)는 지우고 imageId만 남김 */
export function toStorableJSON(json) {
  const walk = (node) => {
    if (node.type === 'image' && node.attrs?.imageId) {
      node = { ...node, attrs: { ...node.attrs, src: '' } };
    }
    if (node.content) node = { ...node, content: node.content.map(walk) };
    return node;
  };
  return walk(json);
}

/** 불러온 JSON: imageId로 화면 표시용 주소를 채움 */
export async function hydrateJSON(json) {
  if (!json) return json;
  const walk = async (node) => {
    if (node.type === 'image' && node.attrs?.imageId) {
      node = { ...node, attrs: { ...node.attrs, src: await urlFor(node.attrs.imageId) } };
    }
    if (node.content) node = { ...node, content: await Promise.all(node.content.map(walk)) };
    return node;
  };
  return walk(json);
}

/* ── 화살표 자동 변환: --> → , <-- ← , ←> ↔ (바로 Backspace를 누르면 원래 글자로) ── */
const Arrows = Extension.create({
  name: 'arrows',
  addInputRules() {
    return [
      textInputRule({ find: /-->$/, replace: '→' }),
      textInputRule({ find: /<--$/, replace: '←' }),
      textInputRule({ find: /←>$/, replace: '↔' }),
    ];
  },
});

/* ── 본문 검색어 표시 ── */
const searchKey = new PluginKey('ybSearch');
function buildHits(doc, term) {
  if (!term) return DecorationSet.empty;
  const q = term.toLowerCase();
  const decos = [];
  doc.descendants((node, pos) => {
    if (!node.isText) return;
    const t = node.text.toLowerCase();
    for (let i = t.indexOf(q); i >= 0; i = t.indexOf(q, i + q.length)) {
      decos.push(Decoration.inline(pos + i, pos + i + q.length, { class: 'search-hit' }));
    }
  });
  return DecorationSet.create(doc, decos);
}
const SearchHighlight = Extension.create({
  name: 'searchHighlight',
  addStorage() {
    return { term: '' };
  },
  addProseMirrorPlugins() {
    const ext = this;
    return [
      new Plugin({
        key: searchKey,
        state: {
          init: () => DecorationSet.empty,
          apply(tr, old) {
            if (tr.getMeta(searchKey) !== undefined || tr.docChanged) return buildHits(tr.doc, ext.storage.term);
            return old;
          },
        },
        props: { decorations: (state) => searchKey.getState(state) },
      }),
    ];
  },
});
/** 검색어를 노트 안에 표시하고 첫 위치로 이동 */
export function setSearchTerm(editor, term) {
  editor.storage.searchHighlight.term = term || '';
  editor.view.dispatch(editor.state.tr.setMeta(searchKey, term || ''));
  if (term) requestAnimationFrame(() => editor.view.dom.querySelector('.search-hit')?.scrollIntoView({ block: 'center' }));
}

/** 그림 파일들을 압축·저장한 뒤 편집기에 삽입 */
async function insertImages(editor, files, getNoteId, pos) {
  for (const file of files) {
    try {
      const { blob, width, height, mime } = await compressImage(file);
      const id = newId('img');
      await putImage({ id, noteId: getNoteId(), blob, width, height, mime, size: blob.size, createdAt: Date.now() });
      const url = URL.createObjectURL(blob);
      urlCache.set(id, url);
      const node = { type: 'image', attrs: { src: url, imageId: id, alt: '' } };
      if (typeof pos === 'number') {
        editor.chain().focus().insertContentAt(pos, node).run();
      } else {
        editor.chain().focus().insertContent(node).run();
      }
    } catch (err) {
      console.error('[YB-EverNote] 그림 처리 실패', err);
      alert('그림을 처리하지 못했습니다. 다른 형식의 그림으로 다시 시도해 주세요.');
    }
  }
}

const imageFiles = (list) => [...(list || [])].filter((f) => f.type.startsWith('image/'));

/**
 * @param {HTMLElement} element 편집 영역
 * @param {{ onUpdate: () => void, getNoteId: () => string, onInk: () => void }} opts
 */
export function createEditor(element, { onUpdate, getNoteId, onInk }) {
  const editor = new Editor({
    element,
    extensions: [
      StarterKit.configure({ link: { openOnClick: false, autolink: true } }),
      TextStyle,
      FontFamily,
      FontSize,
      Color,
      Highlight.configure({ multicolor: true }),
      TaskList,
      TaskItem.configure({ nested: true }),
      NoteImage.configure({ resize: false }),
      Drawing.configure({ getNoteId, onInk }),
      SearchHighlight,
      Arrows,
      Placeholder.configure({ placeholder: '내용을 입력하세요. 그림은 Ctrl+V로 붙여 넣을 수 있습니다.' }),
    ],
    editorProps: {
      attributes: { class: 'note-content', spellcheck: 'false' },
      handlePaste(view, event) {
        const files = imageFiles(event.clipboardData?.files);
        if (!files.length) return false;
        event.preventDefault();
        insertImages(editor, files, getNoteId);
        return true;
      },
      handleDrop(view, event) {
        const files = imageFiles(event.dataTransfer?.files);
        if (!files.length) return false;
        event.preventDefault();
        const pos = view.posAtCoords({ left: event.clientX, top: event.clientY })?.pos;
        insertImages(editor, files, getNoteId, pos);
        return true;
      },
    },
    onUpdate,
  });

  editor.insertImageFiles = (files) => insertImages(editor, imageFiles(files), getNoteId);
  return editor;
}
