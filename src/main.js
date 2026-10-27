import './style.css';
import * as store from './db.js';
import { createEditor, toStorableJSON, hydrateJSON, FONTS, SIZES, HIGHLIGHTS } from './editor.js';

const VERSION = 'v0.1.0 · 1단계';
const $ = (sel) => document.querySelector(sel);
const app = $('#app');

const state = {
  folders: [],
  notes: [],
  filter: 'all', // all | fav | trash | <folderId>
  search: '',
  noteId: null,
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
const titleOf = (n) => n.title?.trim() || n.preview?.split('\n')[0]?.slice(0, 40) || '제목 없음';

/* ───────── 편집기 ───────── */
let saveTimer = null;
let dirty = false;

const editor = createEditor($('#editor'), {
  onUpdate: () => scheduleSave(),
  getNoteId: () => state.noteId,
});

function setSaveState(text) {
  $('#save-state').textContent = text;
}

function scheduleSave() {
  if (!state.noteId) return;
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
  note.content = toStorableJSON(editor.getJSON());
  note.preview = editor.getText({ blockSeparator: '\n' }).trim().slice(0, 120);
  note.updatedAt = Date.now();
  await store.saveNote(note);
  setSaveState('저장됨');
  renderList();
  refreshUsage();
}

async function openNote(id) {
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
  const q = state.search.trim().toLowerCase();
  if (q) list = list.filter((n) => titleOf(n).toLowerCase().includes(q) || (n.preview || '').toLowerCase().includes(q));
  return list;
}

function filterName() {
  if (state.filter === 'all') return '모든 노트';
  if (state.filter === 'fav') return '즐겨찾기';
  if (state.filter === 'trash') return '휴지통';
  return state.folders.find((f) => f.id === state.filter)?.name ?? '폴더';
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
    state.folders.map((f) => item(f, '▢', live.filter((n) => n.folderId === f.id).length, true)).join('');
}

function renderList() {
  $('#list-title').textContent = filterName();
  $('#btn-new').hidden = state.filter === 'trash';
  const notes = visibleNotes();
  const empty = state.filter === 'trash' ? '휴지통이 비어 있습니다.' : '노트가 없습니다. ＋ 새 노트를 눌러 시작하세요.';
  $('#note-list').innerHTML = notes.length
    ? notes
        .map(
          (n) => `
      <li>
        <button class="note-card ${state.noteId === n.id ? 'active' : ''}" data-note="${n.id}">
          <span class="nc-title">${n.fav ? '<span class="star">★</span> ' : ''}${esc(titleOf(n))}</span>
          <span class="nc-preview">${esc((n.preview || '').replace(/\n+/g, ' ').slice(0, 70))}</span>
          <span class="nc-meta">${fmtDate(n.updatedAt)}${n.folderId && state.filter === 'all' ? ' · ' + esc(state.folders.find((f) => f.id === n.folderId)?.name ?? '') : ''}</span>
        </button>
      </li>`
        )
        .join('')
    : `<li class="empty">${empty}</li>`;
  renderFolders();
}

function renderEditorHeader() {
  const note = current();
  const has = !!note;
  const trashed = !!note?.trashedAt;
  $('#note-title').disabled = !has || trashed;
  $('#note-title').value = note?.title ?? '';
  $('#btn-fav').disabled = !has || trashed;
  $('#btn-fav').textContent = note?.fav ? '★' : '☆';
  $('#btn-fav').classList.toggle('on', !!note?.fav);
  $('#btn-delete').disabled = !has;
  $('#btn-delete').title = trashed ? '영구 삭제' : '휴지통으로';
  $('#sel-move').disabled = !has || trashed;
  $('#sel-move').innerHTML =
    `<option value="">미분류</option>` +
    state.folders.map((f) => `<option value="${f.id}">${esc(f.name)}</option>`).join('');
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
    undo: () => c.undo(),
    redo: () => c.redo(),
  };
  if (cmd === 'image') return $('#file-image').click();
  map[cmd]?.().run();
}

/* ───────── 동작 ───────── */
async function reload() {
  [state.folders, state.notes] = await Promise.all([store.listFolders(), store.listNotes()]);
}

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
    content: null,
    preview: '',
    trashedAt: null,
    createdAt: now,
    updatedAt: now,
  };
  await store.saveNote(note);
  state.notes.unshift(note);
  await openNote(note.id);
  $('#note-title').focus();
}

async function addFolder() {
  const name = prompt('새 폴더 이름')?.trim();
  if (!name) return;
  const now = Date.now();
  const folder = { id: store.newId('fld'), name, order: state.folders.length, createdAt: now, updatedAt: now };
  await store.saveFolder(folder);
  state.folders.push(folder);
  state.filter = folder.id;
  renderList();
  renderEditorHeader();
}

async function folderMenu(id) {
  const f = state.folders.find((x) => x.id === id);
  if (!f) return;
  const name = prompt(`폴더 이름 변경\n(이름을 모두 지우고 확인하면 폴더를 삭제합니다)`, f.name);
  if (name === null) return;
  if (name.trim() === '') {
    if (!confirm(`'${f.name}' 폴더를 삭제할까요?\n안의 노트는 지워지지 않고 '모든 노트'에 남습니다.`)) return;
    await flushSave();
    await store.deleteFolder(id);
    await reload();
    if (state.filter === id) state.filter = 'all';
  } else {
    f.name = name.trim();
    f.updatedAt = Date.now();
    await store.saveFolder(f);
  }
  renderList();
  renderEditorHeader();
}

async function toggleFav() {
  const n = current();
  if (!n) return;
  n.fav = !n.fav;
  n.updatedAt = Date.now();
  await store.saveNote(n);
  renderList();
  renderEditorHeader();
}

async function moveNote(folderId) {
  const n = current();
  if (!n) return;
  n.folderId = folderId || null;
  n.updatedAt = Date.now();
  await store.saveNote(n);
  renderList();
}

async function deleteNote() {
  const n = current();
  if (!n) return;
  await flushSave();
  if (n.trashedAt) return purgeNote();
  n.trashedAt = Date.now();
  await store.saveNote(n);
  await openNote(null);
}

async function restoreNote() {
  const n = current();
  if (!n) return;
  n.trashedAt = null;
  n.updatedAt = Date.now();
  await store.saveNote(n);
  state.filter = n.folderId && state.folders.some((f) => f.id === n.folderId) ? n.folderId : 'all';
  await openNote(n.id);
}

async function purgeNote() {
  const n = current();
  if (!n || !confirm('이 노트를 영구 삭제할까요? 되돌릴 수 없습니다.')) return;
  await store.purgeNote(n.id);
  state.notes = state.notes.filter((x) => x.id !== n.id);
  await openNote(null);
  refreshUsage();
}

async function refreshUsage() {
  const u = await store.imageUsage();
  $('#usage').textContent = u.count ? ` · 그림 ${u.count}장 ${(u.bytes / 1048576).toFixed(1)}MB` : '';
}

/* ───────── 이벤트 연결 ───────── */
document.addEventListener('click', async (e) => {
  const t = e.target;
  const folder = t.closest('[data-folder]');
  if (folder) {
    await flushSave();
    state.filter = folder.dataset.folder;
    state.search = '';
    $('#search').value = '';
    app.dataset.view = 'list';
    return renderList();
  }
  const menu = t.closest('[data-folder-menu]');
  if (menu) return folderMenu(menu.dataset.folderMenu);
  if (t.closest('#btn-add-folder')) return addFolder();
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
  if (document.visibilityState === 'hidden') flushSave();
});
window.addEventListener('pagehide', flushSave);

/* ───────── 시작 ───────── */
(async () => {
  $('#version').textContent = VERSION;
  buildToolbar();
  await reload();
  renderList();
  renderEditorHeader();
  refreshUsage();
  if (navigator.storage?.persist) navigator.storage.persist().catch(() => {});
})();
