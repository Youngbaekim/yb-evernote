import './style.css';
import { getTheme, setTheme } from './theme.js';
import { applyLayout, cycleLayout } from './layout.js';
import * as store from './store.js';
import { signIn, signOutUser, watchAuth, finishRedirect } from './firebase.js';
import { createEditor, toStorableJSON, hydrateJSON, setSearchTerm, FONTS, SIZES, HIGHLIGHTS, TEXT_COLORS } from './editor.js';
import { newDrawingAttrs, flushAllDrawings, getDrawingView, resetZoom } from './drawing.js';
import { makeSortable } from './sortable.js';
import { DEVICE_ID } from './device.js';

const VERSION = 'v0.6.2 · 6단계';
const $ = (sel) => document.querySelector(sel);
const app = $('#app');

const state = {
  folders: [],
  notes: [],
  filter: 'all', // all | fav | trash | <folderId>
  search: '',
  tag: '', // 해시태그 필터 (# 없이)
  noteId: null,
  settings: { paper: 'infinite', background: 'lined', textBackground: 'lined', noteSort: 'manual' },
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
  keepVersion(note);
  note.updatedBy = DEVICE_ID; // 다음 저장부터는 '이 기기에서 고친 노트'
  note.title = $('#note-title').value;
  note.tags = tagsOf(note.title);
  note.content = toStorableJSON(editor.getJSON());
  note.preview = editor.getText({ blockSeparator: '\n' }).trim().slice(0, 120);
  note.updatedAt = Date.now();
  store.saveNote(note);
  setSaveState('저장됨');
  renderList();
}

/* ───────── 이전 버전 보관 ─────────
   저장하기 직전의 내용을 보관: ① 다른 기기에서 마지막으로 고친 노트를 이 기기에서 처음 고칠 때
   ② 같은 기기라도 마지막 보관 후 30분이 지났을 때 (노트마다 최근 20개) */
const VERSION_GAP = 30 * 60 * 1000;
const hasBody = (n) => !!((n.title || '').trim() || /"type":"(text|image|drawing)"/.test(JSON.stringify(n.content || {})));
function keepVersion(note) {
  const now = Date.now();
  const fromOther = !!note.updatedBy && note.updatedBy !== DEVICE_ID;
  if (!fromOther && note.verAt && now - note.verAt < VERSION_GAP) return;
  if (!hasBody(note)) return;
  store.putVersion(note.id, { title: note.title, content: note.content }, fromOther ? 'other' : 'auto');
  note.verAt = now;
}

const REASON = { auto: '자동 보관', other: '다른 기기에서 고친 내용', restore: '복원하기 직전 내용' };
const fmtTime = (t) => {
  const d = new Date(t);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}. ${d.getMonth() + 1}. ${d.getDate()}. ${p(d.getHours())}:${p(d.getMinutes())}`;
};

async function openHistory() {
  const note = current();
  if (!note || (note.locked && !isUnlocked())) return;
  await flushAllDrawings();
  await flushSave();
  const dlg = $('#history');
  const list = $('#history-list');
  const view = $('#history-view');
  view.hidden = true;
  list.innerHTML = '<li class="hint">불러오는 중…</li>';
  dlg.showModal();
  let versions = [];
  try { versions = await store.listVersions(note.id); } catch (err) { console.error(err); }
  if (!versions.length) {
    list.innerHTML = '<li class="hint">아직 보관된 이전 버전이 없습니다. 노트를 고치면 30분마다, 그리고 다른 기기에서 고친 노트를 이 기기에서 고칠 때 자동으로 보관됩니다.</li>';
    return;
  }
  list.innerHTML = versions.map((v, i) => {
    const text = plainText(v.content).join('').replace(/\s+/g, ' ').trim();
    return `<li data-i="${i}">
      <div class="vh-meta"><b>${fmtTime(v.savedAt)}</b><span>${REASON[v.reason] || ''}${v.reason === 'other' ? '' : v.device === DEVICE_ID ? ' · 이 기기' : ' · 다른 기기'}</span></div>
      <div class="vh-prev">${esc(v.title || '(제목 없음)')} — ${esc(text.slice(0, 70)) || '(내용 없음)'}</div>
      <div class="vh-acts"><button type="button" class="btn-text" data-vh="view">보기</button><button type="button" class="btn-text" data-vh="restore">이 버전으로 복원</button></div>
    </li>`;
  }).join('');
  list.onclick = async (e) => {
    const b = e.target.closest('[data-vh]');
    if (!b) return;
    const v = versions[Number(b.closest('li').dataset.i)];
    if (b.dataset.vh === 'view') {
      const text = plainText(v.content).join('').replace(/\n{3,}/g, '\n\n').trim();
      view.innerHTML = `<div class="vh-meta"><b>${fmtTime(v.savedAt)}</b><button type="button" class="btn-text" data-vh-close>닫기</button></div><h4>${esc(v.title || '(제목 없음)')}</h4><pre>${esc(text) || '(내용 없음)'}</pre><p class="hint">글자만 미리 보여 줍니다. 그림·필기는 복원하면 함께 돌아옵니다.</p>`;
      view.hidden = false;
      view.querySelector('[data-vh-close]').onclick = () => { view.hidden = true; };
      return;
    }
    if (!confirm(`${fmtTime(v.savedAt)} 버전으로 되돌릴까요?\n지금 내용은 이전 버전 목록에 따로 보관됩니다.`)) return;
    const cur = current();
    if (!cur) return;
    store.putVersion(cur.id, { title: cur.title, content: cur.content }, 'restore');
    cur.title = v.title;
    cur.tags = tagsOf(v.title);
    cur.content = v.content;
    cur.updatedAt = Date.now();
    cur.verAt = Date.now();
    store.saveNote(cur);
    dlg.close();
    await openNote(cur.id);
    renderList();
    setSaveState('복원됨');
  };
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
  if (note.locked && !isUnlocked()) {
    // 잠긴 노트: 비밀번호를 넣기 전에는 내용을 불러오지 않음
    editor.commands.setContent('', { emitUpdate: false });
    $('#editor').hidden = true;
    $('#empty-state').hidden = true;
    showLockGate(note);
    return;
  }
  $('#lock-gate')?.remove();
  $('#editor').hidden = false;
  $('#empty-state').hidden = true;
  const content = await hydrateJSON(note.content);
  editor.commands.setContent(content || '', { emitUpdate: false });
  editor.setEditable(!note.trashedAt, false); // false: 여는 것만으로는 '수정됨'으로 저장하지 않음
  setSearchTerm(editor, state.search.trim());
  setSaveState('');
  updateToolbar();
}

/* ───────── 본문 전체 검색 ───────── */
const textCache = new Map(); // 노트 ID → { at, text }
function plainText(node, out = []) {
  if (!node) return out;
  if (node.type === 'text') out.push(node.text);
  if (node.type === 'drawing') out.push(' ');
  (node.content || []).forEach((c) => plainText(c, out));
  if (['paragraph', 'heading', 'listItem', 'taskItem'].includes(node.type)) out.push('\n');
  return out;
}
function fullText(n) {
  const hit = textCache.get(n.id);
  if (hit && hit.at === n.updatedAt) return hit.text;
  const text = plainText(n.content).join('').replace(/\n{2,}/g, '\n').trim();
  textCache.set(n.id, { at: n.updatedAt, text });
  return text;
}
/** 검색어 주변 문장 일부 (찾은 단어는 굵게) */
function snippet(text, q) {
  const i = text.toLowerCase().indexOf(q);
  if (i < 0) return null;
  const start = Math.max(0, i - 24);
  const pre = (start > 0 ? '…' : '') + text.slice(start, i);
  return `${esc(pre)}<b class="hit">${esc(text.slice(i, i + q.length))}</b>${esc(text.slice(i + q.length, i + q.length + 60))}`.replace(/\n/g, ' ');
}

/* ───────── 잠금 노트 (내용 가리기) ───────── */
let unlockedUntil = 0;
const UNLOCK_MS = 10 * 60 * 1000; // 한 번 풀면 10분 동안, 앱을 백그라운드로 보내면 바로 다시 잠김
const isUnlocked = () => Date.now() < unlockedUntil;
async function hashPin(pin, salt) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`${salt}:${pin}`));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
async function setPin() {
  const s = state.settings;
  if (s.pinHash) {
    const old = prompt('현재 잠금 비밀번호');
    if (old === null) return false;
    if ((await hashPin(old, s.pinSalt)) !== s.pinHash) { alert('비밀번호가 맞지 않습니다.'); return false; }
  }
  const p1 = prompt('새 잠금 비밀번호 (숫자 또는 문자 4자 이상)');
  if (p1 === null) return false;
  if (p1.length < 4) { alert('4자 이상으로 정해 주세요.'); return false; }
  const p2 = prompt('한 번 더 입력해 주세요');
  if (p2 !== p1) { alert('두 번 입력한 비밀번호가 다릅니다.'); return false; }
  const salt = crypto.getRandomValues(new Uint32Array(2)).join('-');
  state.settings = { ...s, pinSalt: salt, pinHash: await hashPin(p1, salt) };
  store.saveSettings(state.settings);
  unlockedUntil = Date.now() + UNLOCK_MS;
  return true;
}
async function checkPin(pin) {
  const s = state.settings;
  return !!s.pinHash && (await hashPin(pin, s.pinSalt)) === s.pinHash;
}
function showLockGate(note) {
  $('#lock-gate')?.remove();
  $('.editor-wrap').insertAdjacentHTML('beforeend', `
    <form id="lock-gate" class="lock-gate">
      <div class="lg-icon">🔒</div>
      <p class="lg-title">잠긴 노트입니다</p>
      <p class="lg-sub">${esc(titleOf(note))}</p>
      <input id="lg-pin" type="password" inputmode="numeric" autocomplete="off" placeholder="잠금 비밀번호" />
      <button class="btn-primary" type="submit">열기</button>
      <p id="lg-msg" class="lg-msg"></p>
    </form>`);
  $('#lg-pin').focus();
  $('#lock-gate').onsubmit = async (e) => {
    e.preventDefault();
    if (await checkPin($('#lg-pin').value)) {
      unlockedUntil = Date.now() + UNLOCK_MS;
      $('#lock-gate').remove();
      renderList();
      openNote(note.id);
    } else {
      $('#lg-msg').textContent = '비밀번호가 맞지 않습니다.';
      $('#lg-pin').select();
    }
  };
}
async function toggleLock() {
  const n = current();
  if (!n) return;
  await flushSave();
  if (n.locked) {
    if (!isUnlocked()) return; // 잠금 화면에서 먼저 풀어야 함
    if (!confirm('이 노트의 잠금을 해제할까요?')) return;
    n.locked = false;
  } else {
    if (!state.settings.pinHash) {
      alert('먼저 잠금 비밀번호를 정합니다. (모든 잠긴 노트에 같은 비밀번호를 씁니다)');
      if (!(await setPin())) return;
    }
    n.locked = true;
    unlockedUntil = Date.now() + UNLOCK_MS; // 잠근 직후에는 계속 볼 수 있음
  }
  store.updateFields('notes', n.id, { locked: n.locked });
  renderList();
  renderEditorHeader({ keepTitle: true });
}
function relock() {
  unlockedUntil = 0;
  const n = current();
  if (n?.locked) openNote(n.id);
  renderList();
}

/* ───────── 렌더링 ───────── */
function visibleNotes() {
  let list = state.notes;
  if (state.filter === 'trash') list = list.filter((n) => n.trashedAt);
  else {
    list = list.filter((n) => !n.trashedAt);
    if (state.filter === 'fav') list = list.filter((n) => n.fav);
    else if (state.filter === 'locked') list = list.filter((n) => n.locked);
    else if (state.filter !== 'all') list = list.filter((n) => n.folderId === state.filter);
  }
  if (state.tag) list = list.filter((n) => tagsOf(n.title).includes(state.tag));
  const q = state.search.trim().toLowerCase();
  if (q) {
    list = list.filter((n) =>
      (n.title || '').toLowerCase().includes(q) || ((!n.locked || isUnlocked()) && fullText(n).toLowerCase().includes(q))
    );
  }
  return sortNotes(list);
}

/* ───────── 정렬 ───────── */
const SORTS = { manual: '직접 정렬', updated: '수정일순', created: '만든 날짜순', title: '제목순' };
const noteOrder = (n) => n.order ?? -(n.updatedAt || 0);
function sortNotes(list) {
  const mode = state.settings.noteSort || 'manual';
  const by = {
    manual: (a, b) => noteOrder(a) - noteOrder(b),
    updated: (a, b) => b.updatedAt - a.updatedAt,
    created: (a, b) => b.createdAt - a.createdAt,
    title: (a, b) => titleOf(a).localeCompare(titleOf(b), 'ko'),
  }[mode] || ((a, b) => noteOrder(a) - noteOrder(b));
  return [...list].sort(by);
}

/** 순서값 정하기: 앞뒤 항목 사이 값. 간격이 너무 좁으면 목록 전체를 다시 매김 */
function between(prev, next) {
  if (prev == null && next == null) return 0;
  if (prev == null) return next - 1000;
  if (next == null) return prev + 1000;
  return (prev + next) / 2;
}

/** 노트를 끌어 놓았을 때 */
function dropNote(srcId, target, place) {
  const n = state.notes.find((x) => x.id === srcId);
  if (!n) return;
  // 왼쪽 폴더 위에 놓으면 그 폴더로 이동
  if (target.dataset.fid) {
    n.folderId = target.dataset.fid;
    store.updateFields('notes', n.id, { folderId: n.folderId });
    renderList();
    if (state.noteId === n.id) renderEditorHeader({ keepTitle: true });
    return;
  }
  const list = visibleNotes().filter((x) => x.id !== srcId);
  let i = list.findIndex((x) => x.id === target.dataset.note);
  if (i < 0) return;
  if (place === 'after') i += 1;
  const prev = list[i - 1] ? noteOrder(list[i - 1]) : null;
  const next = list[i] ? noteOrder(list[i]) : null;
  if (prev != null && next != null && Math.abs(next - prev) < 1e-6) {
    // 다시 매기기
    list.splice(i, 0, n);
    const base = noteOrder(list[0]);
    const updates = list.map((x, k) => { x.order = base + k * 1000; return { id: x.id, fields: { order: x.order } }; });
    store.updateMany('notes', updates);
  } else {
    n.order = between(prev, next);
    store.updateFields('notes', n.id, { order: n.order });
  }
  renderList();
}

/** 폴더를 끌어 놓았을 때: 위·아래는 같은 단계에서 순서 변경, 가운데는 그 폴더 안으로 */
function dropFolder(srcId, target, place) {
  const f = folderById(srcId);
  const t = folderById(target.dataset.fid);
  if (!f || !t || f.id === t.id) return;
  if (folderPath(t.id).some((x) => x.id === f.id)) return; // 자기 하위로는 이동 불가
  if (place === 'inside') {
    const kids = childrenOf(t.id).filter((x) => x.id !== f.id);
    f.parentId = t.id;
    f.order = kids.length ? Math.max(...kids.map((x) => x.order ?? 0)) + 1000 : 0;
    collapsed.delete(t.id);
  } else {
    const sibs = childrenOf(t.parentId ?? null).filter((x) => x.id !== f.id);
    let i = sibs.findIndex((x) => x.id === t.id) + (place === 'after' ? 1 : 0);
    f.parentId = t.parentId ?? null;
    f.order = between(sibs[i - 1]?.order ?? null, sibs[i]?.order ?? null);
  }
  store.updateFields('folders', f.id, { parentId: f.parentId, order: f.order });
  state.folders.sort((a, b) => (a.order ?? 0) - (b.order ?? 0) || a.createdAt - b.createdAt);
  renderList();
  renderEditorHeader({ keepTitle: true });
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
    `<option value="">#태그</option>` +
    tags.map((t) => `<option value="${esc(t)}">#${esc(t)} (${count.get(t) || 0})</option>`).join('');
  sel.value = state.tag;
  sel.classList.toggle('on', !!state.tag);
}

function previewOf(n) {
  if (n.locked && !isUnlocked()) return '<i>잠긴 노트</i>';
  const q = state.search.trim().toLowerCase();
  if (q) {
    const s = snippet(fullText(n), q);
    if (s) return s;
  }
  return esc((n.preview || '').replace(/\n+/g, ' ').slice(0, 70));
}

function filterName() {
  if (state.filter === 'all') return '모든 노트';
  if (state.filter === 'fav') return '즐겨찾기';
  if (state.filter === 'locked') return '잠긴 노트';
  if (state.filter === 'trash') return '휴지통';
  return folderPath(state.filter).map((f) => f.name).join(' › ') || '폴더';
}

function renderFolders() {
  const live = state.notes.filter((n) => !n.trashedAt);
  const count = {
    all: live.length,
    fav: live.filter((n) => n.fav).length,
    locked: live.filter((n) => n.locked).length,
    trash: state.notes.filter((n) => n.trashedAt).length,
  };
  const sys = [
    { id: 'all', name: '모든 노트', icon: '▤' },
    { id: 'fav', name: '즐겨찾기', icon: '☆' },
    { id: 'locked', name: '잠긴 노트', icon: '🔒' },
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
    `<div class="nav-label"><span>폴더</span><button class="nav-add" id="btn-add-folder" title="최상위 폴더 만들기 (하위 폴더는 각 폴더의 ⋯ 또는 목록의 ＋ 폴더)">＋</button></div>` +
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
        <div class="folder-row ${state.filter === f.id ? 'active' : ''}" data-fid="${f.id}">
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
  const sortSel = $('#sel-sort');
  if (!sortSel.options.length) sortSel.innerHTML = Object.entries(SORTS).map(([k, v]) => `<option value="${k}">${v}</option>`).join('');
  sortSel.value = state.settings.noteSort || 'manual';
  $('#note-list').classList.toggle('manual', sortSel.value === 'manual');
  renderTagSelect();
  $('#btn-new').hidden = state.filter === 'trash';
  $('#btn-new-folder').hidden = ['all', 'fav', 'locked', 'trash'].includes(state.filter);
  const notes = visibleNotes();
  const live = state.notes.filter((n) => !n.trashedAt);
  const isFolder = !['all', 'fav', 'locked', 'trash'].includes(state.filter);
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
          <span class="nc-title">${n.fav ? '<span class="star">★</span> ' : ''}${n.locked ? '<span class="lock">🔒</span> ' : ''}${esc(titleOf(n))}${tagsOf(n.title).map((t) => `<span class="tag-chip" data-tag="${esc(t)}">#${esc(t)}</span>`).join('')}</span>
          <span class="nc-preview">${previewOf(n)}</span>
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
  $('#btn-lock').disabled = !has || trashed;
  $('#btn-lock').textContent = note?.locked ? '🔒' : '🔓';
  $('#btn-lock').title = note?.locked ? '잠긴 노트 (눌러서 잠금 해제)' : '이 노트 잠그기';
  $('#btn-lock').classList.toggle('on', !!note?.locked);
  $('#btn-print').disabled = !has || (note?.locked && !isUnlocked());
  $('#btn-history').disabled = !has || trashed || (note?.locked && !isUnlocked());
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
  $('#tc-group').innerHTML =
    `<button class="tc tc-auto" data-tc="" title="기본 글자색 (밝은 화면: 검정 / 다크 모드: 흰색)">가</button>` +
    TEXT_COLORS.map((c) => `<button class="tc" data-tc="${c.color}" title="글자색 ${c.label}" style="--tc:${c.color}">가</button>`).join('');
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
  const tc = ed.getAttributes('textStyle').color || '';
  document.querySelectorAll('[data-tc]').forEach((b) => b.classList.toggle('active', b.dataset.tc === tc));
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
    if (!['all', 'fav', 'locked', 'trash'].includes(state.filter) && !list.some((f) => f.id === state.filter)) state.filter = 'all';
    renderList();
    renderEditorHeader({ keepTitle: true });
  },
  onNotes(list, remoteIds) {
    state.notes = list;
    state.ready = true;
    // 순서값이 없는 기존 노트: 지금 보이는 순서(수정일순)를 그대로 순서값으로 한 번 기록
    const missing = list.filter((n) => n.order == null);
    if (missing.length) {
      missing.forEach((n) => (n.order = -(n.updatedAt || 0)));
      store.updateMany('notes', missing.map((n) => ({ id: n.id, fields: { order: n.order } })));
    }
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
  onDenied() {
    // 로그인은 됐지만 사용 허용 목록에 없는 계정
    store.stopSync();
    document.body.classList.add('signed-out');
    $('#login-msg').innerHTML = `<b>${esc(state.user?.email || '')}</b><br />이 계정은 아직 사용 허용 목록에 없습니다.<br />관리자에게 이 Gmail 주소를 알려 주세요.<br /><button type="button" class="btn-text" id="btn-denied-out">다른 계정으로 로그인</button>`;
    $('#btn-denied-out').onclick = async () => { await signOutUser(); $('#login-msg').textContent = ''; };
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
  const folderId = ['all', 'fav', 'locked', 'trash'].includes(state.filter) ? null : state.filter;
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
    order: Math.min(0, ...state.notes.map(noteOrder)) - 1000, // 직접 정렬에서 맨 위
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
  if (!parentId) state.filter = folder.id; // 하위 폴더는 만든 뒤에도 상위 폴더 화면에 머묾(카드로 바로 확인)
  renderList();
  renderEditorHeader({ keepTitle: true });
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
  await flushSave(); // 입력 중인 제목·내용을 먼저 저장
  const n = current();
  if (!n) return;
  n.fav = !n.fav;
  n.updatedAt = Date.now();
  store.saveNote(n);
  renderList();
  renderEditorHeader({ keepTitle: true });
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
  $('#btn-pin').textContent = state.settings.pinHash ? '잠금 비밀번호 변경' : '잠금 비밀번호 정하기';
  $('#last-backup').textContent = lastBackupText();
  dlg.showModal();
}
$('#settings').addEventListener('close', async () => {
  const dlg = $('#settings');
  if (dlg.returnValue !== 'save') return;
  state.settings = {
    paper: dlg.querySelector('[name=paper]:checked').value,
    background: dlg.querySelector('[name=background]:checked').value,
    textBackground: dlg.querySelector('[name=textBackground]:checked').value,
    noteSort: state.settings.noteSort || 'manual',
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
  const tcBtn = t.closest('[data-tc]');
  if (tcBtn) {
    const color = tcBtn.dataset.tc;
    return color ? editor.chain().focus().setColor(color).run() : editor.chain().focus().unsetColor().run();
  }
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
  if (t.closest('#btn-pin')) return setPin().then((ok) => ok && alert('잠금 비밀번호를 저장했습니다.'));
  if (t.closest('#btn-backup')) return doBackup();
  if (t.closest('#btn-restore-file')) return $('#file-restore').click();
  if (t.closest('#btn-restore')) return restoreNote();
  if (t.closest('#btn-purge')) return purgeNote();
});

// 도구 모음 버튼이 편집기 선택 영역을 빼앗지 않도록
$('#toolbar').addEventListener('mousedown', (e) => {
  if (e.target.closest('button')) e.preventDefault();
});

$('#btn-new').addEventListener('click', newNote);
$('#btn-new-folder').addEventListener('click', () => addFolder(state.filter));
$('#btn-fav').addEventListener('click', toggleFav);
$('#btn-delete').addEventListener('click', deleteNote);
$('#btn-lock').addEventListener('click', toggleLock);
$('#btn-print').addEventListener('click', printNote);
$('#btn-history').addEventListener('click', openHistory);
$('#btn-layout').addEventListener('click', cycleLayout);
applyLayout();
$('#sel-theme').value = getTheme();
$('#sel-theme').addEventListener('change', (e) => setTheme(e.target.value));
$('#sel-move').addEventListener('change', (e) => moveNote(e.target.value));
$('#sel-bg').addEventListener('change', (e) => setNoteBackground(e.target.value));
$('#sel-sort').addEventListener('change', (e) => {
  state.settings = { ...state.settings, noteSort: e.target.value };
  store.saveSettings(state.settings);
  renderList();
});

// 끌어서 순서 바꾸기: 노트(직접 정렬일 때 순서, 왼쪽 폴더 위에 놓으면 이동), 폴더(순서·하위로 이동)
makeSortable({
  root: $('#note-list'),
  item: '.note-card',
  targets: '.note-card, .folder-row[data-fid]',
  enabled: () => state.filter !== 'trash',
  places: (src, t) => {
    if (t.dataset.fid) return ['inside'];
    return (state.settings.noteSort || 'manual') === 'manual' && !state.search.trim() ? ['before', 'after'] : [];
  },
  onDrop: (src, t, place) => dropNote(src.dataset.note, t, place),
});
makeSortable({
  root: $('#folder-nav'),
  item: '.folder-row[data-fid]',
  targets: '.folder-row[data-fid]',
  places: (src, t) => (folderPath(t.dataset.fid).some((x) => x.id === src.dataset.fid) ? [] : ['before', 'inside', 'after']),
  onDrop: (src, t, place) => dropFolder(src.dataset.fid, t, place),
});

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
  if (state.noteId && !$('#editor').hidden) setSearchTerm(editor, state.search.trim());
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
let hiddenAt = 0;
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') {
    flushAllDrawings();
    flushSave();
    hiddenAt = Date.now();
  } else if (hiddenAt && Date.now() - hiddenAt > 30 * 1000 && isUnlocked()) {
    relock(); // 30초 넘게 다른 앱에 있다 돌아오면 잠긴 노트를 다시 잠금
  }
});
setInterval(() => { if (unlockedUntil && !isUnlocked()) { unlockedUntil = 0; relock(); } }, 30 * 1000);
window.addEventListener('pagehide', flushSave);

/* ───────── 인쇄·PDF ───────── */
async function printNote() {
  resetZoom(); // 확대한 필기는 원래 크기로 인쇄
  await flushAllDrawings();
  await flushSave();
  const n = current();
  if (!n) return;
  $('#print-title').textContent = stripTags(n.title) || titleOf(n);
  const prev = document.title;
  document.title = (stripTags(n.title) || 'YB-EverNote').replace(/[\\/:*?"<>|]/g, ' ');
  window.print(); // 인쇄 창에서 '대상: PDF로 저장'을 고르면 PDF 파일
  document.title = prev;
}

/* ───────── 백업·복원 ───────── */
const BACKUP_KEY = () => `yb-last-backup-${state.user?.uid}`;
function lastBackupText() {
  let t = 0;
  try { t = Number(localStorage.getItem(BACKUP_KEY()) || 0); } catch { /* 무시 */ }
  if (!t) return '이 기기에서 백업한 적 없음';
  const days = Math.floor((Date.now() - t) / 86400000);
  return `마지막 백업: ${new Date(t).toLocaleDateString('ko-KR')} (${days ? `${days}일 전` : '오늘'})`;
}
async function doBackup() {
  const btn = $('#btn-backup');
  btn.disabled = true;
  btn.textContent = '백업 파일 만드는 중…';
  try {
    await flushAllDrawings();
    await flushSave();
    const data = await store.exportAllCloud();
    const blob = new Blob([JSON.stringify(data)], { type: 'application/json' });
    const d = new Date();
    const name = `YB-EverNote_backup_${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}.json`;
    const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(blob), download: name });
    ($('dialog[open]') || document.body).appendChild(a); // 설정 창이 열려 있으면 그 안에서 눌러야 파일 이름이 유지됨
    a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 2000);
    try { localStorage.setItem(BACKUP_KEY(), String(Date.now())); } catch { /* 무시 */ }
    $('#last-backup').textContent = lastBackupText();
    alert(`백업 파일을 저장했습니다.\n노트 ${data.notes.length}개 · 폴더 ${data.folders.length}개 · 그림 ${data.images.length}장 · 필기 묶음 ${data.chunks.length}개`);
  } catch (err) {
    console.error(err);
    alert('백업하지 못했습니다. 인터넷 연결을 확인한 뒤 다시 시도해 주세요.');
  } finally {
    btn.disabled = false;
    btn.textContent = '전체 백업 파일 받기';
  }
}
$('#file-restore').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  let data;
  try { data = JSON.parse(await file.text()); } catch { return alert('백업 파일을 읽지 못했습니다.'); }
  if (data?.app !== 'YB-EverNote') return alert('YB-EverNote 백업 파일이 아닙니다.');
  const msg = `${data.exportedAt?.slice(0, 10) || ''} 백업을 복원할까요?\n노트 ${data.notes.length}개 · 폴더 ${data.folders.length}개 · 그림 ${data.images.length}장\n\n같은 노트는 백업 시점 내용으로 바뀌고, 백업 이후 새로 만든 노트는 그대로 남습니다.`;
  if (!confirm(msg)) return;
  await store.importAll(data);
  alert('복원을 마쳤습니다.');
});
function backupReminder() {
  let t = 0;
  try { t = Number(localStorage.getItem(BACKUP_KEY()) || 0); } catch { /* 무시 */ }
  if (state.notes.length < 3 || (t && Date.now() - t < 7 * 86400000)) return;
  const toast = $('#toast');
  if (!toast.hidden) return;
  toast.innerHTML = `${t ? '마지막 백업 후 일주일이 지났습니다.' : '아직 백업 파일이 없습니다.'} <button class="btn-text" id="btn-backup-now">지금 백업</button><button class="btn-text" id="btn-backup-later">나중에</button>`;
  toast.hidden = false;
  $('#btn-backup-now').onclick = () => { toast.hidden = true; doBackup(); };
  $('#btn-backup-later').onclick = () => { toast.hidden = true; };
}

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
  $('#login-msg').textContent = '';
  document.body.classList.remove('signed-out');
  $('#account').textContent = user.email;
  store.startSync(user.uid, syncHandlers);
  renderList();
  renderEditorHeader();
  setTimeout(refreshUsage, 2000);
  offerMigration();
  setTimeout(backupReminder, 8000);
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
