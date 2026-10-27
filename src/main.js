import './style.css';
import * as store from './store.js';
import { signIn, signOutUser, watchAuth, finishRedirect } from './firebase.js';
import { createEditor, toStorableJSON, hydrateJSON, FONTS, SIZES, HIGHLIGHTS } from './editor.js';
import { newDrawingAttrs, flushAllDrawings, getDrawingView } from './drawing.js';

const VERSION = 'v0.4.1 · 4단계';
const $ = (sel) => document.querySelector(sel);
const app = $('#app');

const state = {
  folders: [],
  notes: [],
  filter: 'all', // all | fav | trash | <folderId>
  search: '',
  tag: '', // 해시태그 필터 (# 없이)
  noteId: null,
  settings: { paper: 'infinite', background: 'lined', textBackground: 'lined' },
  user: null,
  ready: false, // 첫 동기화 자료를 받았는지
};

/* ───────── 공통 도구 ───────── */
const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

function fmtDate(ts) {
  const d = new Date(ts);
  const now = new Date();
  if (d.toDateString() === now.toDateString()) {
    return d.toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' });
  }
  const sameYear = d.getFullYear() === now.getFullYear();
  return sameYear ? `${d.getMonth() + 1}월 ${d.getDate()}일` : `${d.getFullYear()}. ${d.getMonth() + 1}. ${d.getDate()}.`;
}

const current = () => state.notes.find((n) => n.id === state.noteId) || null;
/* 해시태그: 제목 속 '#단어' (한글·영문·숫자·_·-) */
const TAG_RE = /#([\p{L}\p{N}_-]+)/gu;
const tagsOf = (title) => [...new Set([...(title || '').matchAll(TAG_RE)].map((m) => m[1]))];
const stripTags = (title) => (title || '').replace(TAG_RE, '').replace(/\s{2,}/g, ' ').trim();
const titleOf = (n) => stripTags(n.title) || n.preview?.split('\n')[0]?.slice(0, 40) || '제목 없음';

/* ───────── 폴더 트리 ───────── */
const FOLDER_SVG = `<svg class="f-svg" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"><path d="M3 6.5A1.5 1.5 0 014.5 5h4l2 2h9A1.5 1.5 0 0121 8.5v9a1.5 1.5 0 01-1.5 1.5h-15A1.5 1.5 0 013 17.5z"/></svg>`;
const folderById = (id) => state.folders.find((f) => f.id === id);
const childrenOf = (pid) => state.folders.filter((f) => (f.parentId ?? null) === (pid ?? null));
/** 상위→하위 경로 (예: [Words&Thoughts, (필기) 예배]) */
function folderPath(id) {
  const path = [];
  const seen = new Set();
  let f = folderById(id);
  while (f && !seen.has(f.id)) { seen.add(f.id); path.unshift(f); f = folderById(f.parentId); }
  return path;
}
/** 트리 순서로 펼친 목록 [{ folder, depth }] */
function folderTree(pid = null, depth = 0, out = [], seen = new Set()) {
  for (const f of childrenOf(pid)) {
    if (seen.has(f.id)) continue;
    seen.add(f.id);
    out.push({ folder: f, depth });
    folderTree(f.id, depth + 1, out, seen);
  }
  return out;
}
const collapsed = new Set((() => { try { return JSON.parse(localStorage.getItem('yb-collapsed') || '[]'); } catch { return []; } })());
function toggleCollapse(id) {
  collapsed.has(id) ? collapsed.delete(id) : collapsed.add(id);
  try { localStorage.setItem('yb-collapsed', JSON.stringify([...collapsed])); } catch { /* 무시 */ }
  renderFolders();
}

/* ───────── 편집기 ───────── */
let saveTimer = null;
let dirty = false;

const editor = createEditor($('#editor'), {
  onUpdate: () => scheduleSave(),
  getNoteId: () => state.noteId,
  onInk: () => scheduleSave(true),
});

function setSaveState(text) {
  $('#save-state').textContent = text;
}

function scheduleSave(force = false) {
  if (!state.noteId) return;
  if (force === true) dirty = true;
  dirty = true;
  setSaveState('저장 중…');
  clearTimeout(saveTimer);
  saveTimer = setTimeout(flushSave, 600);
}

async function flushSave() {
  clearTimeout(saveTimer);
  if (!dirty || !state.noteId) return;
  dirty = false;
  const note = current();
  if (!note) return;
  note.title = $('#note-title').value;
  note.tags = tagsOf(note.title);
  note.content = toStorableJSON(editor.getJSON());
  note.preview = editor.getText({ blockSeparator: '\n' }).trim().slice(0, 120);
  note.updatedAt = Date.now();
  store.saveNote(note);
  setSaveState('저장됨');
  renderList();
}

async function openNote(id) {
  await flushAllDrawings();
  await flushSave();
  state.noteId = id;
  const note = current();
  app.dataset.view = id ? 'editor' : 'list';
  renderList();
  renderEditorHeader();
  if (!note) {
    $('#editor').hidden = true;
    $('#empty-state').hidden = false;
    return;
  }
  $('#editor').hidden = false;
  $('#empty-state').hidden = true;
  const content = await hydrateJSON(note.content);
  editor.commands.setContent(content || '', { emitUpdate: false });
  editor.setEditable(!note.trashedAt);
  setSaveState('');
  updateToolbar();
}

/* ───────── 렌더링 ───────── */
function visibleNotes() {
  let list = state.notes;
  if (state.filter === 'trash') list = list.filter((n) => n.trashedAt);
  else {
    list = list.filter((n) => !n.trashedAt);
    if (state.filter === 'fav') list = list.filter((n) => n.fav);
    else if (state.filter !== 'all') list = list.filter((n) => n.folderId === state.filter);
  }
  if (state.tag) list = list.filter((n) => tagsOf(n.title).includes(state.tag));
  const q = state.search.trim().toLowerCase();
  if (q) list = list.filter((n) => titleOf(n).toLowerCase().includes(q) || (n.preview || '').toLowerCase().includes(q));
  return list;
}

function renderTagSelect() {
  const count = new Map();
  for (const n of state.notes) {
    if (n.trashedAt) continue;
    for (const t of tagsOf(n.title)) count.set(t, (count.get(t) || 0) + 1);
  }
  const tags = [...count.keys()].sort((a, b) => a.localeCompare(b, 'ko'));
  if (state.tag && !count.has(state.tag)) tags.unshift(state.tag);
  const sel = $('#sel-tag');
  sel.innerHTML =
    `<option value="">#태그 전체</option>` +
    tags.map((t) => `<option value="${esc(t)}">#${esc(t)} (${count.get(t) || 0})</option>`).join('');
  sel.value = state.tag;
  sel.classList.toggle('on', !!state.tag);
}

function filterName() {
  if (state.filter === 'all') return '모든 노트';
  if (state.filter === 'fav') return '즐겨찾기';
  if (state.filter === 'trash') return '휴지통';
  return folderPath(state.filter).map((f) => f.name).join(' › ') || '폴더';
}

function renderFolders() {
  const live = state.notes.filter((n) => !n.trashedAt);
  const count = {
    all: live.length,
    fav: live.filter((n) => n.fav).length,
    trash: state.notes.filter((n) => n.trashedAt).length,
  };
  const sys = [
    { id: 'all', name: '모든 노트', icon: '▤' },
    { id: 'fav', name: '즐겨찾기', icon: '☆' },
    { id: 'trash', name: '휴지통', icon: '🗑' },
  ];
  const item = (f, icon, n, editable) => `
    <div class="folder-row ${state.filter === f.id ? 'active' : ''}">
      <button class="folder" data-folder="${f.id}">
        <span class="f-icon">${icon}</span><span class="f-name">${esc(f.name)}</span><span class="f-count">${n}</span>
      </button>
      ${editable ? `<button class="f-more" data-folder-menu="${f.id}" title="이름 변경·삭제">⋯</button>` : ''}
    </div>`;
  $('#folder-nav').innerHTML =
    sys.map((f) => item(f, f.icon, count[f.id], false)).join('') +
    `<div class="nav-label"><span>폴더</span><button class="nav-add" id="btn-add-folder" title="새 폴더">＋</button></div>` +
    folderBranch(null, live);
}

/** 폴더 트리: 하위 폴더는 들여쓰고 왼쪽 세로선·가로선으로 연결 */
function folderBranch(pid, live, seen = new Set()) {
  const kids = childrenOf(pid).filter((f) => !seen.has(f.id));
  if (!kids.length) return '';
  return kids
    .map((f) => {
      seen.add(f.id);
      const hasKids = childrenOf(f.id).length > 0;
      const open = !collapsed.has(f.id);
      const n = live.filter((x) => x.folderId === f.id).length;
      const sub = hasKids && open ? `<div class="tree-children">${folderBranch(f.id, live, seen)}</div>` : '';
      return `
      <div class="tree-node">
        <div class="folder-row ${state.filter === f.id ? 'active' : ''}">
          ${hasKids ? `<button class="f-caret ${open ? 'open' : ''}" data-collapse="${f.id}" title="${open ? '접기' : '펼치기'}">▸</button>` : '<span class="f-caret-sp"></span>'}
          <button class="folder" data-folder="${f.id}">
            <span class="f-icon">${FOLDER_SVG}</span><span class="f-name">${esc(f.name)}</span><span class="f-count">${n}</span>
          </button>
          <button class="f-more" data-folder-menu="${f.id}" title="하위 폴더 추가·이름 변경·삭제">⋯</button>
        </div>${sub}
      </div>`;
    })
    .join('');
}

function renderList() {
  $('#list-title').textContent = filterName() + (state.tag ? ` · #${state.tag}` : '');
  renderTagSelect();
  $('#btn-new').hidden = state.filter === 'trash';
  const notes = visibleNotes();
  const live = state.notes.filter((n) => !n.trashedAt);
  const isFolder = !['all', 'fav', 'trash'].includes(state.filter);
  const subs = isFolder && !state.search.trim() ? childrenOf(state.filter) : [];
  const empty = state.filter === 'trash' ? '휴지통이 비어 있습니다.' : '노트가 없습니다. ＋ 새 노트를 눌러 시작하세요.';
  const subHtml = subs.length
    ? `<li class="sub-folders">${subs
        .map((f) => {
          const cnt = live.filter((n) => n.folderId === f.id).length + childrenOf(f.id).length;
          return `<button class="sub-folder" data-folder="${f.id}" title="${esc(f.name)}"><span class="sf-count">${cnt}</span><span class="sf-icon">${FOLDER_SVG}</span><span class="sf-name">${esc(f.name)}</span></button>`;
        })
        .join('')}</li>`
    : '';
  $('#note-list').innerHTML = subHtml + (notes.length
    ? notes
        .map(
          (n) => `
      <li>
        <button class="note-card ${state.noteId === n.id ? 'active' : ''}" data-note="${n.id}">
          <span class="nc-title">${n.fav ? '<span class="star">★</span> ' : ''}${esc(titleOf(n))}${tagsOf(n.title).map((t) => `<span class="tag-chip" data-tag="${esc(t)}">#${esc(t)}</span>`).join('')}</span>
          <span class="nc-preview">${esc((n.preview || '').replace(/\n+/g, ' ').slice(0, 70))}</span>
          <span class="nc-meta">${fmtDate(n.updatedAt)}${n.folderId && state.filter === 'all' ? ' · ' + esc(folderPath(n.folderId).map((f) => f.name).join(' › ')) : ''}</span>
        </button>
      </li>`
        )
        .join('')
    : subs.length ? '' : `<li class="empty">${empty}</li>`);
  renderFolders();
}

function renderEditorHeader({ keepTitle = false } = {}) {
  const note = current();
  const has = !!note;
  const trashed = !!note?.trashedAt;
  $('#note-title').disabled = !has || trashed;
  if (!keepTitle) $('#note-title').value = note?.title ?? '';
  $('#btn-fav').disabled = !has || trashed;
  $('#btn-fav').textContent = note?.fav ? '★' : '☆';
  $('#btn-fav').classList.toggle('on', !!note?.fav);
  $('#btn-delete').disabled = !has;
  $('#btn-delete').title = trashed ? '영구 삭제' : '휴지통으로';
  $('#sel-move').disabled = !has || trashed;
  $('#sel-bg').disabled = !has || trashed;
  const bg = note?.background ?? state.settings.textBackground; // 배경을 정하지 않은 노트는 설정의 기본 배경
  $('#sel-bg').value = bg;
  $('#editor').dataset.bg = bg;
  $('#sel-move').innerHTML =
    `<option value="">미분류</option>` +
    folderTree().map(({ folder: f, depth }) => `<option value="${f.id}">${'\u3000'.repeat(depth)}${depth ? '└ ' : ''}${esc(f.name)}</option>`).join('');
  $('#sel-move').value = note?.folderId ?? '';
  $('#toolbar').classList.toggle('disabled', !has || trashed);
  $('#trash-banner')?.remove();
  if (trashed) {
    $('.editor-wrap').insertAdjacentHTML(
      'afterbegin',
      `<div id="trash-banner" class="trash-banner">휴지통에 있는 노트입니다.
        <button class="btn-text" id="btn-restore">복원</button>
        <button class="btn-text danger" id="btn-purge">영구 삭제</button></div>`
    );
  }
}

/* ───────── 도구 모음 ───────── */
function buildToolbar() {
  $('#sel-font').innerHTML = FONTS.map((f) => `<option value='${f.value}'>${f.label}</option>`).join('');
  $('#sel-size').innerHTML = `<option value="">크기</option>` + SIZES.map((s) => `<option value="${s}">${parseInt(s)}</option>`).join('');
  $('#hl-group').innerHTML =
    HIGHLIGHTS.map((h) => `<button class="hl" data-hl="${h.color}" title="형광펜 ${h.label}" style="--hl:${h.color}"></button>`).join('') +
    `<button class="hl hl-none" data-hl="" title="형광펜 지우기">⌀</button>`;
}

function updateToolbar() {
  const ed = editor;
  const set = (cmd, on) => document.querySelector(`[data-cmd="${cmd}"]`)?.classList.toggle('active', on);
  set('bold', ed.isActive('bold'));
  set('italic', ed.isActive('italic'));
  set('underline', ed.isActive('underline'));
  set('strike', ed.isActive('strike'));
  set('h1', ed.isActive('heading', { level: 1 }));
  set('h2', ed.isActive('heading', { level: 2 }));
  set('bullet', ed.isActive('bulletList'));
  set('ordered', ed.isActive('orderedList'));
  set('task', ed.isActive('taskList'));
  const ts = ed.getAttributes('textStyle');
  $('#sel-font').value = ts.fontFamily ?? '';
  $('#sel-size').value = ts.fontSize ?? '';
  const hl = ed.getAttributes('highlight').color;
  document.querySelectorAll('[data-hl]').forEach((b) => b.classList.toggle('active', !!hl && b.dataset.hl === hl));
}
window.__ybEditor = editor; // 점검용
window.__ybDrawing = getDrawingView; // 점검용
editor.on('selectionUpdate', updateToolbar);
editor.on('transaction', updateToolbar);

function runCmd(cmd) {
  const c = editor.chain().focus();
  const map = {
    bold: () => c.toggleBold(),
    italic: () => c.toggleItalic(),
    underline: () => c.toggleUnderline(),
    strike: () => c.toggleStrike(),
    h1: () => c.toggleHeading({ level: 1 }),
    h2: () => c.toggleHeading({ level: 2 }),
    bullet: () => c.toggleBulletList(),
    ordered: () => c.toggleOrderedList(),
    task: () => c.toggleTaskList(),
    drawing: () => c.insertContent([{ type: 'drawing', attrs: newDrawingAttrs(state.settings) }, { type: 'paragraph' }]),
    undo: () => c.undo(),
    redo: () => c.redo(),
  };
  if (cmd === 'image') return $('#file-image').click();
  map[cmd]?.().run();
  if (cmd === 'drawing') {
    // 방금 넣은 필기 블록을 바로 쓸 수 있게 활성화
    const { $from } = editor.state.selection;
    let id = null;
    editor.state.doc.nodesBetween(Math.max(0, $from.pos - 4), $from.pos, (n) => {
      if (n.type.name === 'drawing') id = n.attrs.drawingId;
    });
    if (id) setTimeout(() => getDrawingView(id)?.activate(), 0);
  }
}

/* ───────── 동작 ───────── */
/* ───────── 동기화 (Firestore → 화면) ───────── */
async function reloadOpenNoteFromRemote() {
  const note = current();
  if (!note) return;
  const content = await hydrateJSON(note.content);
  const { from } = editor.state.selection;
  editor.commands.setContent(content || '', { emitUpdate: false });
  const max = editor.state.doc.content.size;
  editor.commands.setTextSelection(Math.min(from, max));
  setSaveState('다른 기기에서 수정됨');
}

const syncHandlers = {
  onFolders(list) {
    state.folders = list;
    if (!['all', 'fav', 'trash'].includes(state.filter) && !list.some((f) => f.id === state.filter)) state.filter = 'all';
    renderList();
    renderEditorHeader({ keepTitle: true });
  },
  onNotes(list, remoteIds) {
    state.notes = list;
    state.ready = true;
    if (state.noteId && !current()) {
      openNote(null); // 다른 기기에서 영구 삭제됨
      return;
    }
    renderList();
    const typing = dirty || document.activeElement === $('#note-title');
    if (state.noteId && remoteIds.includes(state.noteId) && !dirty) {
      reloadOpenNoteFromRemote();
      if (!typing) renderEditorHeader();
    } else {
      renderEditorHeader({ keepTitle: true });
    }
  },
  onSettings(s) {
    state.settings = s;
    renderEditorHeader({ keepTitle: true });
  },
  onStatus({ pending }) {
    const el = $('#sync');
    if (!navigator.onLine) { el.textContent = '● 오프라인 · 기기에 저장 중'; el.dataset.s = 'off'; }
    else if (pending) { el.textContent = '● 동기화 중…'; el.dataset.s = 'pending'; }
    else { el.textContent = '● 동기화됨'; el.dataset.s = 'ok'; }
  },
};
window.addEventListener('online', () => syncHandlers.onStatus({ pending: true }));
window.addEventListener('offline', () => syncHandlers.onStatus({ pending: true }));

async function newNote() {
  await flushSave();
  const folderId = ['all', 'fav', 'trash'].includes(state.filter) ? null : state.filter;
  const now = Date.now();
  const note = {
    id: store.newId('note'),
    type: 'text',
    title: '',
    folderId,
    fav: state.filter === 'fav',
    background: state.settings.textBackground,
    content: null,
    preview: '',
    trashedAt: null,
    createdAt: now,
    updatedAt: now,
  };
  store.saveNote(note);
  state.notes.unshift(note);
  await openNote(note.id);
  $('#note-title').focus();
}

async function addFolder(parentId = null) {
  const parent = parentId ? folderById(parentId) : null;
  const name = prompt(parent ? `'${parent.name}' 안에 만들 폴더 이름` : '새 폴더 이름')?.trim();
  if (!name) return;
  const now = Date.now();
  const folder = { id: store.newId('fld'), name, parentId: parentId ?? null, order: state.folders.length, createdAt: now, updatedAt: now };
  if (parentId) collapsed.delete(parentId);
  store.saveFolder(folder);
  state.folders.push(folder);
  state.filter = folder.id;
  renderList();
  renderEditorHeader();
}

function folderMenu(id, anchor) {
  const f = folderById(id);
  if (!f) return;
  const r = anchor.getBoundingClientRect();
  const menu = $('#ctx-menu');
  menu.innerHTML = `
    <button data-fm="add">＋ 하위 폴더 추가</button>
    <button data-fm="rename">이름 변경</button>
    <button data-fm="delete" class="danger">폴더 삭제</button>`;
  menu.hidden = false;
  menu.style.left = `${Math.min(r.left, window.innerWidth - 190)}px`;
  menu.style.top = `${Math.min(r.bottom + 4, window.innerHeight - 140)}px`;
  menu.onclick = (e) => {
    const act = e.target.closest('[data-fm]')?.dataset.fm;
    menu.hidden = true;
    if (act === 'add') addFolder(id);
    if (act === 'rename') renameFolder(f);
    if (act === 'delete') removeFolder(f);
  };
}

function renameFolder(f) {
  const name = prompt('폴더 이름 변경', f.name)?.trim();
  if (!name) return;
  f.name = name;
  f.updatedAt = Date.now();
  store.saveFolder(f);
  renderList();
  renderEditorHeader({ keepTitle: true });
}

async function removeFolder(f) {
  const parent = folderById(f.parentId);
  const subfolders = childrenOf(f.id);
  const notes = state.notes.filter((n) => n.folderId === f.id);
  const dest = parent ? `'${parent.name}' 폴더` : (subfolders.length ? '최상위·미분류' : "'모든 노트'(미분류)");
  if (!confirm(`'${f.name}' 폴더를 삭제할까요?\n안의 노트 ${notes.length}개${subfolders.length ? `와 하위 폴더 ${subfolders.length}개` : ''}는 지워지지 않고 ${dest}로 옮겨집니다.`)) return;
  await flushSave();
  store.deleteFolder(f.id, { notes, subfolders, parentId: f.parentId ?? null });
  state.folders = state.folders.filter((x) => x.id !== f.id);
  if (state.filter === f.id) state.filter = f.parentId || 'all';
  renderList();
  renderEditorHeader({ keepTitle: true });
}

async function toggleFav() {
  const n = current();
  if (!n) return;
  n.fav = !n.fav;
  n.updatedAt = Date.now();
  store.saveNote(n);
  renderList();
  renderEditorHeader();
}

async function setNoteBackground(bg) {
  const n = current();
  if (!n) return;
  n.background = bg;
  n.updatedAt = Date.now();
  store.saveNote(n);
  $('#editor').dataset.bg = bg;
  renderList();
}

async function moveNote(folderId) {
  const n = current();
  if (!n) return;
  n.folderId = folderId || null;
  n.updatedAt = Date.now();
  store.saveNote(n);
  renderList();
}

async function deleteNote() {
  const n = current();
  if (!n) return;
  await flushSave();
  if (n.trashedAt) return purgeNote();
  n.trashedAt = Date.now();
  store.saveNote(n);
  await openNote(null);
}

async function restoreNote() {
  const n = current();
  if (!n) return;
  n.trashedAt = null;
  n.updatedAt = Date.now();
  store.saveNote(n);
  state.filter = n.folderId && state.folders.some((f) => f.id === n.folderId) ? n.folderId : 'all';
  await openNote(n.id);
}

async function purgeNote() {
  const n = current();
  if (!n || !confirm('이 노트를 영구 삭제할까요? 되돌릴 수 없습니다.')) return;
  store.purgeNote(n.id);
  state.notes = state.notes.filter((x) => x.id !== n.id);
  await openNote(null);
  setTimeout(refreshUsage, 3000);
}

async function refreshUsage() {
  const u = await store.imageUsage();
  if (u) $('#usage').textContent = u.count ? ` · 그림 ${u.count}장 ${(u.bytes / 1048576).toFixed(1)}MB` : '';
}

/* ───────── 설정 ───────── */
function openSettings() {
  const s = state.settings;
  const dlg = $('#settings');
  dlg.querySelector(`[name=paper][value=${s.paper}]`).checked = true;
  dlg.querySelector(`[name=background][value=${s.background}]`).checked = true;
  dlg.querySelector(`[name=textBackground][value=${s.textBackground}]`).checked = true;
  $('#account-email').textContent = state.user?.email ?? '';
  dlg.showModal();
}
$('#settings').addEventListener('close', async () => {
  const dlg = $('#settings');
  if (dlg.returnValue !== 'save') return;
  state.settings = {
    paper: dlg.querySelector('[name=paper]:checked').value,
    background: dlg.querySelector('[name=background]:checked').value,
    textBackground: dlg.querySelector('[name=textBackground]:checked').value,
  };
  store.saveSettings(state.settings);
  renderEditorHeader({ keepTitle: true });
});

/* ───────── 이벤트 연결 ───────── */
document.addEventListener('click', async (e) => {
  const t = e.target;
  if (!t.closest('#ctx-menu') && !t.closest('[data-folder-menu]')) $('#ctx-menu').hidden = true;
  const caret = t.closest('[data-collapse]');
  if (caret) return toggleCollapse(caret.dataset.collapse);
  const folder = t.closest('[data-folder]');
  if (folder) {
    await flushSave();
    state.filter = folder.dataset.folder;
    if (state.filter === 'all') state.tag = ''; // '모든 노트'는 태그 필터도 해제
    state.search = '';
    $('#search').value = '';
    app.dataset.view = 'list';
    return renderList();
  }
  const menu = t.closest('[data-folder-menu]');
  if (menu) return folderMenu(menu.dataset.folderMenu, menu);
  if (t.closest('#btn-add-folder')) return addFolder(null);
  const chip = t.closest('.tag-chip');
  if (chip) {
    e.stopPropagation();
    state.tag = chip.dataset.tag;
    return renderList();
  }
  const card = t.closest('[data-note]');
  if (card) return openNote(card.dataset.note);
  const go = t.closest('[data-go]');
  if (go) {
    if (go.dataset.go === 'list') await flushSave();
    app.dataset.view = go.dataset.go;
    return;
  }
  const cmd = t.closest('[data-cmd]');
  if (cmd) return runCmd(cmd.dataset.cmd);
  const hl = t.closest('[data-hl]');
  if (hl) {
    const color = hl.dataset.hl;
    return color
      ? editor.chain().focus().toggleHighlight({ color }).run()
      : editor.chain().focus().unsetHighlight().run();
  }
  if (t.closest('#btn-settings')) return openSettings();
  if (t.closest('#btn-signin')) return doSignIn();
  if (t.closest('#btn-signout')) return doSignOut();
  if (t.closest('#btn-install')) return installApp();
  if (t.closest('#btn-restore')) return restoreNote();
  if (t.closest('#btn-purge')) return purgeNote();
});

// 도구 모음 버튼이 편집기 선택 영역을 빼앗지 않도록
$('#toolbar').addEventListener('mousedown', (e) => {
  if (e.target.closest('button')) e.preventDefault();
});

$('#btn-new').addEventListener('click', newNote);
$('#btn-fav').addEventListener('click', toggleFav);
$('#btn-delete').addEventListener('click', deleteNote);
$('#sel-move').addEventListener('change', (e) => moveNote(e.target.value));
$('#sel-bg').addEventListener('change', (e) => setNoteBackground(e.target.value));
$('#sel-tag').addEventListener('change', (e) => {
  state.tag = e.target.value;
  app.dataset.view = 'list';
  renderList();
});
$('#note-title').addEventListener('input', scheduleSave);
$('#note-title').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    editor.commands.focus('start');
  }
});
$('#search').addEventListener('input', (e) => {
  state.search = e.target.value;
  renderList();
});
$('#sel-font').addEventListener('change', (e) => {
  const v = e.target.value;
  const c = editor.chain().focus();
  (v ? c.setFontFamily(v) : c.unsetFontFamily()).run();
});
$('#sel-size').addEventListener('change', (e) => {
  const v = e.target.value;
  const c = editor.chain().focus();
  (v ? c.setFontSize(v) : c.unsetFontSize()).run();
});
$('#file-image').addEventListener('change', (e) => {
  editor.insertImageFiles(e.target.files);
  e.target.value = '';
});

// 창을 닫거나 백그라운드로 갈 때 저장
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') { flushAllDrawings(); flushSave(); }
});
window.addEventListener('pagehide', flushSave);

/* ───────── 로그인 ───────── */
async function doSignIn() {
  const btn = $('#btn-signin');
  btn.disabled = true;
  $('#login-msg').textContent = '';
  try {
    await signIn();
  } catch (err) {
    console.error(err);
    $('#login-msg').textContent = `로그인하지 못했습니다 (${err.code || err.message}). 잠시 후 다시 시도해 주세요.`;
  } finally {
    btn.disabled = false;
  }
}

async function doSignOut() {
  if (!confirm('로그아웃할까요? 다시 로그인하면 노트가 그대로 보입니다.')) return;
  await flushAllDrawings();
  await flushSave();
  $('#settings').close();
  await signOutUser();
}

/** 1·2단계에서 이 기기에만 저장한 노트를 계정으로 옮기기 */
async function offerMigration() {
  const all = await store.localDataSummary();
  if (!all) return;
  const msg = `이 기기에 저장된 기존 노트 ${all.notes.length}개(폴더 ${all.folders.length}개, 그림 ${all.images.length}장)를 계정으로 옮길까요?\n\n옮기면 다른 기기에서도 보입니다. 취소하면 다시 묻지 않습니다.`;
  if (!confirm(msg)) return store.skipMigration();
  const el = $('#sync');
  await store.migrateLocal(all, (done, total) => { el.textContent = `● 기존 노트 옮기는 중 ${done}/${total}`; });
  el.textContent = '● 옮기기 완료';
}

function onSignedIn(user) {
  state.user = user;
  document.body.classList.remove('signed-out');
  $('#account').textContent = user.email;
  store.startSync(user.uid, syncHandlers);
  renderList();
  renderEditorHeader();
  setTimeout(refreshUsage, 2000);
  offerMigration();
}

async function onSignedOut() {
  store.stopSync();
  state.user = null;
  state.notes = [];
  state.folders = [];
  state.noteId = null;
  await openNote(null);
  document.body.classList.add('signed-out');
}

/* ───────── 앱 설치·업데이트 (4단계) ───────── */
let installEvent = null;
window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault(); // 브라우저 기본 안내 대신 설정 창의 '앱 설치' 버튼 사용
  installEvent = e;
  $('#btn-install').hidden = false;
});
window.addEventListener('appinstalled', () => {
  installEvent = null;
  $('#btn-install').hidden = true;
});
async function installApp() {
  if (!installEvent) return;
  installEvent.prompt();
  await installEvent.userChoice;
  installEvent = null;
  $('#btn-install').hidden = true;
}

function showUpdateToast(worker) {
  const t = $('#toast');
  t.innerHTML = `새 버전이 준비되었습니다. <button class="btn-text" id="btn-update">새로고침</button>`;
  t.hidden = false;
  $('#btn-update').onclick = async () => {
    await flushAllDrawings();
    await flushSave();
    worker.postMessage('skipWaiting');
  };
}

function registerServiceWorker() {
  if (!('serviceWorker' in navigator) || !import.meta.env.PROD) return;
  let reloading = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (reloading) return;
    reloading = true;
    location.reload();
  });
  navigator.serviceWorker.register('sw.js').then((reg) => {
    if (reg.waiting && navigator.serviceWorker.controller) showUpdateToast(reg.waiting);
    reg.addEventListener('updatefound', () => {
      const w = reg.installing;
      w?.addEventListener('statechange', () => {
        if (w.state === 'installed' && navigator.serviceWorker.controller) showUpdateToast(w);
      });
    });
    // 앱을 오래 켜 두어도 하루 한 번 새 버전 확인
    setInterval(() => reg.update().catch(() => {}), 24 * 60 * 60 * 1000);
  }).catch((err) => console.warn('[YB-EverNote] 서비스 워커 등록 실패', err));
}

const isIOS = /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const isStandalone = window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;

/* ───────── 시작 ───────── */
(async () => {
  $('#version').textContent = VERSION;
  buildToolbar();
  renderList();
  renderEditorHeader();
  finishRedirect();
  registerServiceWorker();
  $('#ios-hint').hidden = !(isIOS && !isStandalone);
  document.body.classList.toggle('standalone', isStandalone);
  watchAuth((user) => (user ? onSignedIn(user) : onSignedOut()));
  if (navigator.storage?.persist) navigator.storage.persist().catch(() => {});
})();
