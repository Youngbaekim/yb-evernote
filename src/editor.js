// Tiptap 편집기 — 폰트·크기, 체크박스, 형광펜, 그림 붙여넣기
import { Editor, Extension } from '@tiptap/core';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';
import StarterKit from '@tiptap/starter-kit';
import { TextStyle, FontFamily, FontSize, Color } from '@tiptap/extension-text-style';
import Highlight from '@tiptap/extension-highlight';
import { TaskList, TaskItem } from '@tiptap/extension-list';
import Image from '@tiptap/extension-image';
import { Placeholder } from '@tiptap/extensions';
import { compressImage } from './image.js';
import { Drawing } from './drawing.js';
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

const NoteImage = Image.extend({
  addAttributes() {
    return {
      ...this.parent?.(),
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
      NoteImage.configure({ resize: { enabled: true, minWidth: 60, alwaysPreserveAspectRatio: true, directions: ['top-left', 'top-right', 'bottom-left', 'bottom-right'] } }),
      Drawing.configure({ getNoteId, onInk }),
      SearchHighlight,
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
