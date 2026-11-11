import './style.css';
import { getTheme, setTheme } from './theme.js';
import { applyLayout, cycleLayout } from './layout.js';
import { initNoteZoom, stepZoom, setZoom, getZoom } from './notezoom.js';
import * as store from './store.js';
import { signIn, signOutUser, watchAuth, finishRedirect } from './firebase.js';
import { createEditor, toStorableJSON, hydrateJSON, setSearchTerm, FONTS, SIZES, HIGHLIGHTS, TEXT_COLORS } from './editor.js';
import { newDrawingAttrs, flushAllDrawings, getDrawingView, resetZoom } from './drawing.js';
import { makeSortable } from './sortable.js';
import { DEVICE_ID } from './device.js';
import QRCode from 'qrcode';
import { newShareId, isWebUrl, hostLabel, normCode, CODE_RE, sanitizeHtml, htmlText, htmlTitle, byteSize } from './share-utils.js';
import { createHtmlView } from './htmlnote.js';

const VERSION = 'v0.9.6 · 9단계';
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
const SYS_FILTERS = ['all', 'fav', 'locked', 'trash', 'none']; // 폴더가 아닌 보기 (none = 폴더 미지정)
const TRASH_DAYS = 30; // 휴지통 보관 기간
const DAY = 86400000;
const NOFOLDER_SVG = `<svg class="f-svg" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.7" stroke-dasharray="2.6 2.2" stroke-linejoin="round"><path d="M3 6.5A1.5 1.5 0 014.5 5h4l2 2h9A1.5 1.5 0 0121 8.5v9a1.5 1.5 0 01-1.5 1.5h-15A1.5 1.5 0 013 17.5z"/></svg>`;
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

/* HTML 노트 보기·편집 화면 (일반 노트 편집기와 번갈아 표시) */
const isHtml = (n) => n?.type === 'html';
const HTML_MAX = 900 * 1024; // Firestore 문서 한 건 1MiB 안에서 여유
const htmlView = createHtmlView($('.editor-wrap'), { onChange: () => scheduleSave() });

function setSaveState(text) {
  $('#save-state').textContent = text;
}

function scheduleSave(force = false) {
  if (!state.noteId) return;
  if (force === true) dirty = true;
  dirty = true;
  setSaveState('저장 중…');
  clearTimeout(saveTimer);
  saveTimer = setTimeout(autoFlush, 600);
}
/* 한글 등 조합 입력 중(자음·모음이 아직 한 글자로 합쳐지는 중)에는 자동 저장·화면 갱신을 미룸
   — 안드로이드 키보드는 조합 중에 화면이 바뀌면 자모가 분리되어 입력될 수 있음 */
const composing = () => !!editor.view.composing;
function autoFlush() {
  if (composing()) { saveTimer = setTimeout(autoFlush, 500); return; }
  flushSave();
}
let deferredNotes = null;
editor.view.dom.addEventListener('compositionend', () => {
  setTimeout(() => {
    if (composing() || !deferredNotes) return;
    const [list, ids] = deferredNotes;
    deferredNotes = null;
    syncHandlers.onNotes(list, ids);
  }, 50);
});

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
  if (isHtml(note)) {
    if (htmlView.visible) {
      const html = htmlView.serialize();
      if (byteSize(html) > HTML_MAX) {
        setSaveState('용량 초과 — 저장 안 됨');
        alert('이 HTML 노트가 저장 가능한 크기(약 900KB)를 넘어 저장하지 못했습니다.\n문서 안의 큰 그림을 줄이거나 빼 주세요.');
        return;
      }
      note.html = html;
      note.preview = htmlText(html).slice(0, 120);
    }
  } else {
    note.content = toStorableJSON(editor.getJSON());
    note.preview = editor.getText({ blockSeparator: '\n' }).trim().slice(0, 120);
  }
  note.updatedAt = Date.now();
  store.saveNote(note);
  schedulePublish(note);
  setSaveState('저장됨');
  if (note.id === state.noteId) document.title = `${titleOf(note)} - YB-EverNote`;
  renderList();
}

/* ───────── 이전 버전 보관 ─────────
   저장하기 직전의 내용을 보관: ① 다른 기기에서 마지막으로 고친 노트를 이 기기에서 처음 고칠 때
   ② 같은 기기라도 마지막 보관 후 30분이 지났을 때 (노트마다 최근 20개) */
const VERSION_GAP = 30 * 60 * 1000;
const hasBody = (n) => !!((n.title || '').trim() || n.html || /"type":"(text|image|drawing)"/.test(JSON.stringify(n.content || {})));
function keepVersion(note) {
  const now = Date.now();
  const fromOther = !!note.updatedBy && note.updatedBy !== DEVICE_ID;
  if (!fromOther && note.verAt && now - note.verAt < VERSION_GAP) return;
  if (!hasBody(note)) return;
  store.putVersion(note.id, { title: note.title, content: note.content, html: note.html }, fromOther ? 'other' : 'auto');
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
    const text = (v.html ? htmlText(v.html) : plainText(v.content).join('')).replace(/\s+/g, ' ').trim();
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
      const text = (v.html ? htmlText(v.html) : plainText(v.content).join('')).replace(/\n{3,}/g, '\n\n').trim();
      view.innerHTML = `<div class="vh-meta"><b>${fmtTime(v.savedAt)}</b><button type="button" class="btn-text" data-vh-close>닫기</button></div><h4>${esc(v.title || '(제목 없음)')}</h4><pre>${esc(text) || '(내용 없음)'}</pre><p class="hint">글자만 미리 보여 줍니다. 그림·필기는 복원하면 함께 돌아옵니다.</p>`;
      view.hidden = false;
      view.querySelector('[data-vh-close]').onclick = () => { view.hidden = true; };
      return;
    }
    if (!confirm(`${fmtTime(v.savedAt)} 버전으로 되돌릴까요?\n지금 내용은 이전 버전 목록에 따로 보관됩니다.`)) return;
    const cur = current();
    if (!cur) return;
    store.putVersion(cur.id, { title: cur.title, content: cur.content, html: cur.html }, 'restore');
    cur.title = v.title;
    cur.tags = tagsOf(v.title);
    if (isHtml(cur)) { if (v.html) { cur.html = v.html; cur.preview = htmlText(v.html).slice(0, 120); } } else cur.content = v.content;
    cur.updatedAt = Date.now();
    cur.verAt = Date.now();
    store.saveNote(cur);
    schedulePublish(cur, true);
    dlg.close();
    await openNote(cur.id);
    renderList();
    setSaveState('복원됨');
  };
}

/* ───────── 노트별 주소 (홈 화면 바로가기용) ─────────
   노트를 열면 주소에 ?note=ID, 창 제목에 노트 제목 → 브라우저의 '홈 화면에 추가'가 이 노트로 바로가기를 만듦 */
let pendingNoteId = new URL(location.href).searchParams.get('note'); // 바로가기로 앱을 연 경우
function syncUrl(note) {
  try {
    const url = new URL(location.href);
    if (note) url.searchParams.set('note', note.id);
    else url.searchParams.delete('note');
    if (url.href !== location.href) history.replaceState(null, '', url);
  } catch { /* 무시 */ }
  document.title = note ? `${titleOf(note)} - YB-EverNote` : 'YB-EverNote';
}
const noteUrl = (note) => { const u = new URL(location.href); u.search = ''; u.hash = ''; u.searchParams.set('note', note.id); return u.href; };

async function openNote(id) {
  await flushAllDrawings();
  await flushSave();
  const switched = state.noteId !== id; // 다른 노트로 바꿀 때는 맨 위부터 보이도록
  state.noteId = id;
  const note = current();
  syncUrl(note);
  const wrap = $('.editor-wrap');
  const toTop = () => { if (switched && wrap) { wrap.scrollTop = 0; wrap.scrollLeft = 0; } };
  toTop();
  app.dataset.view = id ? 'editor' : 'list';
  renderList();
  renderEditorHeader();
  htmlView.setEditing(false);
  renderHtmlBar();
  if (!note || !isHtml(note) || (note.locked && !isUnlocked())) htmlView.hide();
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
  $('#empty-state').hidden = true;
  if (isHtml(note)) {
    $('#editor').hidden = true;
    editor.commands.setContent('', { emitUpdate: false });
    await htmlView.show(note.html);
    toTop();
    setSaveState('');
    return;
  }
  $('#editor').hidden = false;
  const content = await hydrateJSON(note.content);
  editor.commands.setContent(content || '', { emitUpdate: false });
  editor.setEditable(!note.trashedAt, false); // false: 여는 것만으로는 '수정됨'으로 저장하지 않음
  toTop();
  requestAnimationFrame(toTop); // 그림·필기가 자리를 잡은 뒤 한 번 더
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
  if (node.type === 'image' && node.attrs?.text) out.push(`\n${node.attrs.text}\n`); // PDF 쪽의 글자
  if (node.type === 'htmlBlock' && node.attrs?.html) out.push(`\n${htmlText(node.attrs.html)}\n`);
  (node.content || []).forEach((c) => plainText(c, out));
  if (['paragraph', 'heading', 'listItem', 'taskItem'].includes(node.type)) out.push('\n');
  return out;
}
function fullText(n) {
  const hit = textCache.get(n.id);
  if (hit && hit.at === n.updatedAt) return hit.text;
  const text = isHtml(n) ? htmlText(n.html) : plainText(n.content).join('').replace(/\n{2,}/g, '\n').trim();
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
    if (n.shareId && !confirm('웹에 게시 중인 노트입니다. 잠그면 게시가 중지됩니다. 계속할까요?')) return;
    if (n.shareId) await stopShare(n, false);
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
    else if (state.filter === 'none') list = list.filter((n) => !n.folderId || !state.folders.some((f) => f.id === n.folderId));
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
    created: (a, b) => (b.createdAt || b.updatedAt || 0) - (a.createdAt || a.updatedAt || 0),
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
  // 왼쪽 폴더 위에 놓으면 그 폴더로 이동 ('폴더 미지정'에 놓으면 폴더에서 빼기)
  if (target.dataset.fid || target.dataset.nofolder) {
    n.folderId = target.dataset.fid || null;
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
  if (state.filter === 'none') return '폴더 미지정';
  return folderPath(state.filter).map((f) => f.name).join(' › ') || '폴더';
}

function renderFolders() {
  const live = state.notes.filter((n) => !n.trashedAt);
  const count = {
    all: live.length,
    fav: live.filter((n) => n.fav).length,
    locked: live.filter((n) => n.locked).length,
    trash: state.notes.filter((n) => n.trashedAt).length,
    none: live.filter((n) => !n.folderId || !state.folders.some((f) => f.id === n.folderId)).length,
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
    `<div class="folder-row nofolder-row ${state.filter === 'none' ? 'active' : ''}" data-nofolder="1" title="어느 폴더에도 넣지 않은 노트 (노트를 여기로 끌어 놓으면 폴더에서 빼기)">
      <span class="f-caret-sp"></span>
      <button class="folder" data-folder="none"><span class="f-icon">${NOFOLDER_SVG}</span><span class="f-name">폴더 미지정</span><span class="f-count">${count.none}</span></button>
    </div>` +
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
  $('#btn-empty-trash').hidden = state.filter !== 'trash' || !state.notes.some((n) => n.trashedAt);
  $('#btn-new-folder').hidden = SYS_FILTERS.includes(state.filter);
  const notes = visibleNotes();
  const live = state.notes.filter((n) => !n.trashedAt);
  const isFolder = !SYS_FILTERS.includes(state.filter);
  const subs = isFolder && !state.search.trim() ? childrenOf(state.filter) : [];
  const empty = state.filter === 'trash' ? `휴지통이 비어 있습니다. 휴지통의 노트는 ${TRASH_DAYS}일 뒤 자동으로 영구 삭제됩니다.` : '노트가 없습니다. ＋ 새 노트를 눌러 시작하세요.';
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
          <span class="nc-meta">${n.trashedAt ? `<span class="trash-left">${daysLeft(n)}일 후 영구 삭제</span> · ` : ''}${state.settings.noteSort === 'created' ? `만든 ${fmtDate(n.createdAt || n.updatedAt)}` : fmtDate(n.updatedAt)}${n.folderId && state.filter === 'all' ? ' · ' + esc(folderPath(n.folderId).map((f) => f.name).join(' › ')) : ''}</span>
        </button>
      </li>`
        )
        .join('')
    : subs.length ? '' : `<li class="empty">${empty}</li>`);
  renderFolders();
}

/* ───────── 노트 만든 시간 (용지 오른쪽 위) ───────── */
const WEEK = ['일요일', '월요일', '화요일', '수요일', '목요일', '금요일', '토요일'];
const p2 = (n) => String(n).padStart(2, '0');
function fmtCreated(ts) {
  const d = new Date(ts);
  return `${d.getFullYear()}.${p2(d.getMonth() + 1)}.${p2(d.getDate())} ${WEEK[d.getDay()]} ${p2(d.getHours())}:${p2(d.getMinutes())}`;
}
const toLocalInput = (ts) => { const d = new Date(ts); return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}T${p2(d.getHours())}:${p2(d.getMinutes())}`; };
function createdLabel() {
  let el = document.getElementById('note-created');
  if (!el) {
    el = document.createElement('button');
    el.id = 'note-created';
    el.className = 'note-created';
    el.type = 'button';
    el.addEventListener('click', editCreated);
    $('#editor').prepend(el);
  }
  return el;
}
function renderCreated(note) {
  const el = createdLabel();
  el.hidden = !note;
  if (!note) return;
  const ts = note.createdAt || note.updatedAt || Date.now();
  const txt = fmtCreated(ts);
  if (el.textContent !== txt) el.textContent = txt; // 바뀔 때만 (편집 중 화면 갱신 최소화)
  el.disabled = !!note.trashedAt;
  el.title = note.trashedAt ? '만든 시간' : '만든 시간 — 눌러서 수정 (만든 날짜순 정렬에 반영)';
}
function editCreated() {
  const note = current();
  if (!note || note.trashedAt) return;
  const dlg = $('#created-dlg');
  const input = $('#created-input');
  input.value = toLocalInput(note.createdAt || note.updatedAt || Date.now());
  const preview = () => { const t = new Date(input.value).getTime(); $('#created-preview').textContent = Number.isFinite(t) ? `표시: ${fmtCreated(t)}` : '날짜와 시간을 정확히 입력해 주세요.'; };
  input.oninput = preview;
  // 숫자를 고친 뒤 Enter = 저장 (폼 기본 동작은 첫 단추인 '취소'로 처리되므로 직접 지정)
  input.onkeydown = (e) => {
    if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); dlg.close('ok'); }
  };
  $('#created-now').onclick = () => { input.value = toLocalInput(Date.now()); preview(); };
  preview();
  dlg.onclose = () => {
    if (dlg.returnValue !== 'ok') return;
    const t = new Date(input.value).getTime();
    const n = current();
    if (!Number.isFinite(t) || !n || n.id !== note.id) return;
    n.createdAt = t;
    store.updateFields('notes', n.id, { createdAt: t }); // 수정일은 그대로, 만든 시간만
    renderCreated(n);
    renderList();
  };
  dlg.returnValue = '';
  dlg.showModal();
}

function renderEditorHeader({ keepTitle = false } = {}) {
  const note = current();
  const has = !!note;
  const trashed = !!note?.trashedAt;
  renderCreated(note);
  $('#note-title').disabled = !has || trashed;
  if (!keepTitle) $('#note-title').value = note?.title ?? '';
  $('#btn-fav').disabled = !has || trashed;
  $('#btn-fav').textContent = note?.fav ? '★' : '☆';
  $('#btn-fav').classList.toggle('on', !!note?.fav);
  $('#btn-delete').disabled = !has;
  $('#btn-more').disabled = !has;
  $('#btn-lock').disabled = !has || trashed;
  $('#btn-lock').textContent = note?.locked ? '🔒' : '🔓';
  $('#btn-lock').title = note?.locked ? '잠긴 노트 (눌러서 잠금 해제)' : '이 노트 잠그기';
  $('#btn-lock').classList.toggle('on', !!note?.locked);
  $('#btn-copy').disabled = !has || trashed;
  $('#btn-share').disabled = !has || trashed || !!note?.locked;
  $('#btn-share').classList.toggle('on', !!note?.shareId);
  $('#btn-share').title = note?.shareId ? '웹에 게시 중 (주소·QR·자료 링크)' : note?.locked ? '잠긴 노트는 웹에 게시할 수 없습니다' : '웹에 게시 (실시간 공유)';
  $('#btn-print').disabled = !has || (note?.locked && !isUnlocked());
  $('#btn-history').disabled = !has || trashed || (note?.locked && !isUnlocked());
  $('#btn-delete').title = trashed ? '영구 삭제' : '휴지통으로';
  $('#sel-move').disabled = !has || trashed;
  $('#sel-bg').disabled = !has || trashed || isHtml(note);
  $('#btn-export').disabled = !has || (note?.locked && !isUnlocked());
  renderBgSelect(note); // 배경을 정하지 않은 노트는 설정의 기본 배경
  $('#sel-move').innerHTML =
    `<option value="">미분류</option>` +
    folderTree().map(({ folder: f, depth }) => `<option value="${f.id}">${'\u3000'.repeat(depth)}${depth ? '└ ' : ''}${esc(f.name)}</option>`).join('');
  $('#sel-move').value = note?.folderId ?? '';
  $('#toolbar').classList.toggle('disabled', !has || trashed);
  $('#toolbar').hidden = isHtml(note);
  app.dataset.notetype = isHtml(note) ? 'html' : 'text'; // HTML 노트는 배경·배율 선택을 숨김
  renderHtmlBar();
  $('#trash-banner')?.remove();
  if (trashed) {
    $('.editor-wrap').insertAdjacentHTML(
      'afterbegin',
      `<div id="trash-banner" class="trash-banner">휴지통에 있는 노트입니다. ${daysLeft(note)}일 후 영구 삭제됩니다.
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
  if (isHtml(note)) {
    if (htmlView.isEditing() || (note.locked && !isUnlocked())) return; // 편집 중이면 덮어쓰지 않음
    const w = $('.editor-wrap');
    const top = w.scrollTop;
    await htmlView.show(note.html);
    w.scrollTop = top;
    setSaveState('다른 기기에서 수정됨');
    return;
  }
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
    if (!SYS_FILTERS.includes(state.filter) && !list.some((f) => f.id === state.filter)) state.filter = 'all';
    renderList();
    renderEditorHeader({ keepTitle: true });
  },
  onNotes(list, remoteIds) {
    if (composing()) { // 조합 입력이 끝난 뒤 반영 (다른 기기 변경 표시가 사라지지 않도록 합쳐 둠)
      deferredNotes = [list, [...new Set([...(deferredNotes?.[1] || []), ...remoteIds])]];
      return;
    }
    state.notes = list;
    state.ready = true;
    setTimeout(purgeExpired, 5000); // 앱을 열 때 한 번: 보관 기간이 지난 휴지통 노트 정리
    if (pendingNoteId) {
      const id = pendingNoteId;
      pendingNoteId = null;
      if (list.some((n) => n.id === id)) { openNote(id); return; }
      syncUrl(null); // 지워진 노트의 바로가기
    }
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
    settingsLoaded = true;
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
  const folderId = SYS_FILTERS.includes(state.filter) ? null : state.filter;
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
    <button data-fm="copy">⧉ 폴더 복제 (하위 폴더·노트 포함)</button>
    <button data-fm="delete" class="danger">폴더 삭제</button>`;
  menu.hidden = false;
  menu.style.left = `${Math.min(r.left, window.innerWidth - 190)}px`;
  menu.style.top = `${Math.min(r.bottom + 4, window.innerHeight - 180)}px`;
  menu.onclick = (e) => {
    const act = e.target.closest('[data-fm]')?.dataset.fm;
    menu.hidden = true;
    if (act === 'add') addFolder(id);
    if (act === 'rename') renameFolder(f);
    if (act === 'copy') duplicateFolder(f);
    if (act === 'delete') removeFolder(f);
  };
}

/** 휴대폰: 잠금·이전 버전·인쇄·삭제를 ⋯ 메뉴로 (PC·태블릿은 머리줄 단추 그대로) */
function noteMenu(anchor) {
  const menu = $('#ctx-menu');
  const items = ['#btn-copy', '#btn-share', '#btn-export', '#btn-lock', '#btn-history', '#btn-print', '#btn-delete']
    .map((id) => $(id))
    .filter((b) => !b.disabled)
    .map((b) => `<button data-nm="${b.id}" class="${b.id === 'btn-delete' ? 'danger' : ''}">${b.textContent} ${esc(b.title)}</button>`);
  if (!items.length) return;
  items.push(`<button data-nm-sc="1">🔗 홈 화면 바로가기 만들기</button>`);
  const pct = Math.round(getZoom() * 100);
  items.unshift(`<div class="nm-zoom"><span>노트 배율</span><button data-nz="-1" aria-label="축소">－</button><button data-nz="0">${pct}%</button><button data-nz="1" aria-label="확대">＋</button></div>`);
  menu.innerHTML = items.join('');
  const r = anchor.getBoundingClientRect();
  menu.hidden = false;
  menu.style.left = `${Math.max(8, Math.min(r.right - 220, window.innerWidth - 228))}px`;
  menu.style.top = `${r.bottom + 4}px`;
  menu.onclick = (e) => {
    const zb = e.target.closest('[data-nz]');
    if (zb) {
      const d = Number(zb.dataset.nz);
      if (d) stepZoom(d); else setZoom(1);
      menu.querySelector('[data-nz="0"]').textContent = `${Math.round(getZoom() * 100)}%`;
      return; // 메뉴는 열어 둔 채로 여러 번 조절
    }
    if (e.target.closest('[data-nm-sc]')) { menu.hidden = true; return openShortcutGuide(); }
    const id = e.target.closest('[data-nm]')?.dataset.nm;
    menu.hidden = true;
    if (id) $('#' + id).click();
  };
}

/** 홈 화면 바로가기 안내 — 웹앱은 바로가기를 직접 만들 수 없어(브라우저만 가능) 기기·브라우저에 맞는 순서를 안내 */
function openShortcutGuide() {
  const note = current();
  if (!note) return;
  const ua = navigator.userAgent;
  const android = /Android/i.test(ua);
  const ios = /iPhone|iPad|iPod/i.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const samsung = /SamsungBrowser/i.test(ua);
  const url = noteUrl(note);
  let steps;
  let openBtn = '';
  if (android && isStandalone) {
    const u = new URL(url);
    const intent = `intent://${u.host}${u.pathname}${u.search}#Intent;scheme=https;package=com.android.chrome;end`;
    openBtn = `<a class="btn-primary sc-open" href="${esc(intent)}">① Chrome에서 이 노트 열기</a>`;
    steps = ['위 단추로 Chrome에서 이 노트를 엽니다.', 'Chrome 오른쪽 위 <b>⋮</b> → <b>홈 화면에 추가</b>를 누릅니다.', '이름을 확인하고 <b>추가</b>를 누릅니다.'];
  } else if (android && samsung) {
    steps = ['아래쪽 <b>≡</b> 메뉴 → <b>현재 페이지 추가</b>를 누릅니다.', '<b>홈 화면</b>을 고릅니다.'];
  } else if (android) {
    steps = ['오른쪽 위 <b>⋮</b> → <b>홈 화면에 추가</b>를 누릅니다.', '이름을 확인하고 <b>추가</b>를 누릅니다.'];
  } else if (ios) {
    steps = ['Safari 아래쪽 <b>공유(□↑)</b> → <b>홈 화면에 추가</b>를 누릅니다.', 'iPhone·iPad는 바로가기마다 따로 로그인해야 합니다.'];
  } else {
    steps = ['브라우저 메뉴에서 <b>바로가기 만들기</b> 또는 <b>홈 화면에 추가</b>를 고릅니다.'];
  }
  const dlg = $('#shortcut-dlg');
  dlg.querySelector('.sc-body').innerHTML = `
    <p class="hint"><b>${esc(titleOf(note))}</b> 노트를 바로 여는 아이콘을 홈 화면에 만듭니다.<br />휴대폰 보안 정책상 앱이 직접 만들 수는 없어, 브라우저 메뉴를 한 번 거칩니다.</p>
    ${openBtn}
    <ol class="sc-steps">${steps.map((t) => `<li>${t}</li>`).join('')}</ol>
    <div class="sc-link"><input readonly value="${esc(url)}" /><button type="button" class="btn-ghost" data-sc-copy>링크 복사</button></div>`;
  dlg.querySelector('[data-sc-copy]').onclick = async (e) => {
    try { await navigator.clipboard.writeText(url); e.target.textContent = '복사됨'; } catch { dlg.querySelector('.sc-link input').select(); }
  };
  dlg.showModal();
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

/* 노트 바탕색: 무늬(줄노트·무지·모눈)와 따로 저장, 다크 모드에서는 어두운 같은 계열로 */
const PAPER_COLORS = [
  { key: '', label: '기본 색' },
  { key: 'cream', label: '노랑' },
  { key: 'mint', label: '연두' },
  { key: 'sky', label: '하늘' },
  { key: 'rose', label: '분홍' },
];
function renderBgSelect(note) {
  const bg = note?.background ?? state.settings.textBackground;
  const color = note?.bgColor || '';
  const pat = [['lined', '줄노트'], ['blank', '무지'], ['grid', '모눈']];
  $('#sel-bg').innerHTML =
    pat.map(([v, l]) => `<option value="${v}">${l}</option>`).join('') +
    `<option disabled>──────</option>` +
    PAPER_COLORS.map((c) => `<option value="c:${c.key}" class="c-opt c-${c.key || 'none'}">${c.key === color ? '✓ ' : '\u3000'}${c.key ? '● ' : '○ '}${c.label}</option>`).join('');
  $('#sel-bg').value = bg;
  $('#sel-bg').dataset.color = color;
  $('#editor').dataset.bg = bg;
  $('#editor').dataset.color = color;
}

async function setNoteBackground(bg) {
  const n = current();
  if (!n) return;
  if (bg.startsWith('c:')) {
    n.bgColor = bg.slice(2) || null;
    n.updatedAt = Date.now();
    store.saveNote(n);
    renderBgSelect(n); // 선택 상자는 무늬 표시로 되돌리고 색에 ✓
    renderList();
    return;
  }
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
  if (!confirm(`'${titleOf(n)}' 노트를 휴지통으로 옮길까요?\n휴지통에서 ${TRASH_DAYS}일 동안 복원할 수 있고, 그 뒤 자동으로 영구 삭제됩니다.`)) return;
  if (n.shareId) await stopShare(n, false);
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
  if (n.shareId) store.unpublish(n.shareId);
  store.purgeNote(n.id);
  state.notes = state.notes.filter((x) => x.id !== n.id);
  await openNote(null);
  setTimeout(refreshUsage, 3000);
}

/* ───────── 휴지통: 30일 지나면 자동 영구 삭제, 한 번에 비우기 ───────── */
const daysLeft = (n) => Math.max(0, Math.ceil((n.trashedAt + TRASH_DAYS * DAY - Date.now()) / DAY));
let expiredChecked = false;
function purgeExpired() {
  if (expiredChecked || !navigator.onLine) return;
  expiredChecked = true;
  const limit = Date.now() - TRASH_DAYS * DAY;
  const old = state.notes.filter((n) => n.trashedAt && n.trashedAt < limit);
  if (!old.length) return;
  old.forEach((n) => { if (n.shareId) store.unpublish(n.shareId); store.purgeNote(n.id); });
  state.notes = state.notes.filter((n) => !old.includes(n));
  if (old.some((n) => n.id === state.noteId)) openNote(null);
  renderList();
  setTimeout(refreshUsage, 3000);
}

async function emptyTrash() {
  const list = state.notes.filter((n) => n.trashedAt);
  if (!list.length) return;
  if (!confirm(`휴지통의 노트 ${list.length}개를 모두 영구 삭제할까요?\n그림·필기·이전 버전도 함께 지워지며 되돌릴 수 없습니다.`)) return;
  list.forEach((n) => { if (n.shareId) store.unpublish(n.shareId); store.purgeNote(n.id); });
  state.notes = state.notes.filter((n) => !n.trashedAt);
  if (list.some((n) => n.id === state.noteId)) await openNote(null);
  renderList();
  setTimeout(refreshUsage, 3000);
}

async function refreshUsage() {
  const u = await store.imageUsage();
  if (u) $('#usage').textContent = u.count ? ` · 그림 ${u.count}장 ${(u.bytes / 1048576).toFixed(1)}MB` : '';
}

/* ───────── 설정 ───────── */
/* 화면 위쪽 여백 (기기별): iPadOS 창 단추·상단 흐림 막이 맨 위 메뉴를 가리는 문제 대응 */
const TOPGAP_KEY = 'yb-top-gap';
const isIPad = () => /iPad/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
function getTopGap() { try { return localStorage.getItem(TOPGAP_KEY) || 'auto'; } catch { return 'auto'; } }
function applyTopGap() {
  const v = getTopGap();
  const px = v === 'auto' ? 0 : Number(v) || 0; // 자동 = 시스템 안전 영역만 따름
  document.documentElement.style.setProperty('--top-gap', `${px}px`);
}
$('#sel-topgap').addEventListener('change', (e) => {
  try { localStorage.setItem(TOPGAP_KEY, e.target.value); } catch { /* 무시 */ }
  applyTopGap();
});

function openSettings() {
  const s = state.settings;
  const dlg = $('#settings');
  dlg.querySelector(`[name=paper][value=${s.paper}]`).checked = true;
  dlg.querySelector(`[name=background][value=${s.background}]`).checked = true;
  dlg.querySelector(`[name=textBackground][value=${s.textBackground}]`).checked = true;
  $('#account-email').textContent = state.user?.email ?? '';
  $('#btn-pin').textContent = state.settings.pinHash ? '잠금 비밀번호 변경' : '잠금 비밀번호 정하기';
  $('#last-backup').textContent = lastBackupText();
  $('#sel-topgap').value = getTopGap();
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
  if (!t.closest('#ctx-menu') && !t.closest('[data-folder-menu]') && !t.closest('#btn-more') && !t.closest('#btn-export')) $('#ctx-menu').hidden = true;
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
$('#btn-empty-trash').addEventListener('click', emptyTrash);
$('#btn-new-folder').addEventListener('click', () => addFolder(state.filter));
$('#btn-fav').addEventListener('click', toggleFav);
$('#btn-delete').addEventListener('click', deleteNote);
$('#btn-more').addEventListener('click', (e) => { const m = $('#ctx-menu'); if (!m.hidden && m.querySelector('[data-nm]')) { m.hidden = true; return; } noteMenu(e.currentTarget); });
$('#btn-lock').addEventListener('click', toggleLock);
$('#btn-share').addEventListener('click', openShare);
$('#btn-copy').addEventListener('click', () => duplicateNote());
// 노트 목록에서 노트를 고른 상태로 Delete 키 → 확인 후 휴지통 (확인 창은 Enter로 승인)
document.addEventListener('keydown', async (e) => {
  if (e.key !== 'Delete' || e.ctrlKey || e.altKey || e.metaKey) return;
  const a = document.activeElement;
  const card = a?.closest?.('.note-card');
  const inList = card || a === document.body || a?.closest?.('.pane-list') && !a.matches('input, select, textarea');
  if (!inList || a?.isContentEditable || a?.matches?.('input, textarea, select')) return;
  const id = card?.dataset.note || state.noteId;
  if (!id) return;
  e.preventDefault();
  if (id !== state.noteId) await openNote(id);
  await deleteNote();
});
$('#btn-export').addEventListener('click', (e) => exportMenu(e.currentTarget));
$('#btn-import-html').addEventListener('click', () => $('#file-html').click());
$('#file-html').addEventListener('change', async (e) => {
  const files = [...e.target.files];
  e.target.value = '';
  await handleFiles(files, 'list'); // 목록의 ⇪: 항상 새 노트
});
// 노트 목록에 .html 파일을 끌어 놓아도 가져오기
$('#note-list').addEventListener('dragover', (e) => {
  if ([...(e.dataTransfer?.items || [])].some((i) => i.kind === 'file')) { e.preventDefault(); $('#note-list').classList.add('drop-file'); }
});
$('#note-list').addEventListener('dragleave', () => $('#note-list').classList.remove('drop-file'));
$('#note-list').addEventListener('drop', async (e) => {
  $('#note-list').classList.remove('drop-file');
  const files = [...(e.dataTransfer?.files || [])].filter((f) => isPdfFile(f) || isHtmlFile(f));
  if (!files.length) return;
  e.preventDefault();
  await handleFiles(files, 'list');
});
$('#btn-print').addEventListener('click', printNote);
$('#btn-history').addEventListener('click', openHistory);
$('#btn-layout').addEventListener('click', cycleLayout);
initNoteZoom();
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
  targets: '.note-card, .folder-row[data-fid], .folder-row[data-nofolder]',
  enabled: () => state.filter !== 'trash',
  places: (src, t) => {
    if (t.dataset.fid || t.dataset.nofolder) return ['inside'];
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
$('#file-image').addEventListener('change', async (e) => {
  const all = [...e.target.files];
  const docs = all.filter((f) => !f.type.startsWith('image/')); // 그림이 아닌 것은 내용으로 확인 (PDF·HTML)
  editor.insertImageFiles(all.filter((f) => !docs.includes(f)));
  if (docs.length) { e.target.value = ''; await handleFiles(docs, 'note'); return; }
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

/* ───────── 복제: 노트 · 폴더(하위 폴더·노트 포함) ─────────
   - 그림·필기는 새 ID로 따로 복사 (원본을 지워도 사본은 그대로)
   - 게시 상태(주소)는 복사하지 않음. 자료 링크·머리말·게시 토글은 그대로 가져가 바로 다시 게시할 수 있음
   - 잠긴 노트는 잠긴 채로 복제 */
function withSuffix(title, suffix) {
  if (!suffix) return title || '';
  const t = title || '';
  const m = t.match(/\s#[\p{L}\p{N}_-]+/u); // 태그 앞에 '(사본)'
  return m ? `${t.slice(0, m.index)}${suffix}${t.slice(m.index)}` : `${t}${suffix}`;
}
/** 직접 정렬에서 원본 바로 아래 자리 */
function orderAfter(src) {
  const o = noteOrder(src);
  const next = state.notes.filter((x) => !x.trashedAt && (x.folderId ?? null) === (src.folderId ?? null) && noteOrder(x) > o).map(noteOrder);
  return next.length ? (o + Math.min(...next)) / 2 : o + 1000;
}
async function cloneNote(src, { folderId = src.folderId ?? null, suffix = ' (사본)', order } = {}) {
  const now = Date.now();
  const id = store.newId('note');
  const content = await store.cloneNoteMedia(id, src.content);
  const { shareId, lastShareId, verAt, updatedBy, ...rest } = src;
  const note = {
    ...rest,
    id,
    title: withSuffix(src.title, suffix),
    content,
    folderId,
    fav: false,
    trashedAt: null,
    order: order ?? orderAfter(src),
    attachments: (src.attachments || []).map((a) => ({ ...a })),
    createdAt: now,
    updatedAt: now,
  };
  note.tags = tagsOf(note.title);
  store.saveNote(note);
  state.notes.push(note);
  return note;
}

async function duplicateNote(id = state.noteId) {
  const src = state.notes.find((n) => n.id === id);
  if (!src || src.trashedAt) return;
  if (id === state.noteId) { await flushAllDrawings(); await flushSave(); }
  setSaveState('복제 중…');
  const copy = await cloneNote(src);
  renderList();
  await openNote(copy.id);
  setSaveState('복제됨');
  const t = $('#note-title');
  t.focus();
  t.select();
}

async function duplicateFolder(f) {
  // 하위 폴더 전체 (트리 순서)
  const tree = [{ folder: f, depth: 0 }, ...folderTree(f.id, 1)];
  const ids = new Set(tree.map((x) => x.folder.id));
  const notes = state.notes.filter((n) => !n.trashedAt && ids.has(n.folderId));
  const subN = tree.length - 1;
  if (!confirm(`‘${f.name}’ 폴더를 복제할까요?\n하위 폴더 ${subN}개, 노트 ${notes.length}개가 그림·필기·자료 링크까지 함께 복사됩니다.\n(웹 게시 상태는 복사하지 않습니다)`)) return;
  await flushAllDrawings();
  await flushSave();
  const now = Date.now();
  const map = new Map(); // 원본 폴더 ID → 사본 폴더 ID
  const siblings = childrenOf(f.parentId ?? null);
  for (const { folder: src } of tree) {
    const top = src.id === f.id;
    const nf = {
      ...src,
      id: store.newId('fld'),
      name: top ? `${src.name} (사본)` : src.name,
      parentId: top ? src.parentId ?? null : map.get(src.parentId),
      order: top ? (src.order ?? 0) + 0.5 : src.order,
      createdAt: now,
      updatedAt: now,
    };
    if (top) { // 원본 바로 아래로
      const i = siblings.findIndex((x) => x.id === src.id);
      nf.order = between(src.order ?? 0, siblings[i + 1]?.order ?? null);
    }
    map.set(src.id, nf.id);
    store.saveFolder(nf);
    state.folders.push(nf);
  }
  state.folders.sort((a, b) => (a.order ?? 0) - (b.order ?? 0) || a.createdAt - b.createdAt);
  let k = 0;
  for (const n of notes) {
    setSaveState(`복제 중… ${++k}/${notes.length}`);
    await cloneNote(n, { folderId: map.get(n.folderId), suffix: '', order: noteOrder(n) });
  }
  setSaveState(notes.length ? `노트 ${notes.length}개 복제됨` : '복제됨');
  state.filter = map.get(f.id);
  collapsed.delete(f.parentId);
  renderList();
  renderEditorHeader({ keepTitle: true });
}

/** 노트 카드 오른쪽 클릭 메뉴 */
function noteCardMenu(id, x, y) {
  const n = state.notes.find((v) => v.id === id);
  if (!n || n.trashedAt) return;
  const menu = $('#ctx-menu');
  const lockedNow = n.locked && !isUnlocked();
  menu.innerHTML = `
    <button data-nc="rename">이름 변경</button>
    <button data-nc="copy">⧉ 노트 복제</button>
    <button data-nc="share" ${n.locked ? 'disabled title="잠긴 노트는 웹에 게시할 수 없습니다"' : ''}><span class="nc-globe${n.shareId ? ' on' : ''}">🌐</span> ${n.shareId ? '웹 게시 설정 (게시 중)' : '웹에 게시'}</button>
    <button data-nc="delete" class="danger">노트 삭제</button>`;
  menu.hidden = false;
  menu.style.left = `${Math.min(x, window.innerWidth - 220)}px`;
  menu.style.top = `${Math.min(y, window.innerHeight - 180)}px`;
  menu.onclick = async (e) => {
    const btn = e.target.closest('[data-nc]');
    if (!btn || btn.disabled) return;
    const act = btn.dataset.nc;
    menu.hidden = true;
    if (act === 'rename') return renameNote(n);
    if (act === 'copy') return duplicateNote(id);
    if (state.noteId !== id) await openNote(id); // 게시·삭제는 그 노트를 연 상태에서 기존 흐름 그대로
    if (act === 'share') { if (lockedNow) return; return openShare(); }
    if (act === 'delete') return deleteNote();
  };
}

/** 목록에서 제목 바꾸기 (#태그 포함 전체 제목) */
async function renameNote(n) {
  if (n.id === state.noteId) await flushSave();
  const t = prompt('노트 제목 (#태그를 붙일 수 있음)', n.title || '');
  if (t === null) return;
  const title = t.trim();
  if (title === (n.title || '')) return;
  n.title = title;
  n.tags = tagsOf(title);
  n.updatedAt = Date.now();
  store.updateFields('notes', n.id, { title, tags: n.tags, updatedAt: n.updatedAt });
  if (n.shareId) schedulePublish(n, true); // 게시 중이면 열람 화면 제목도 바로
  if (n.id === state.noteId) {
    $('#note-title').value = title;
    document.title = `${titleOf(n)} - YB-EverNote`;
  }
  renderList();
}
$('#note-list').addEventListener('contextmenu', (e) => {
  const card = e.target.closest('[data-note]');
  const sub = e.target.closest('.sub-folder[data-folder]');
  if (!card && !sub) return;
  e.preventDefault();
  if (card) noteCardMenu(card.dataset.note, e.clientX, e.clientY);
  else folderMenu(sub.dataset.folder, sub);
});
$('#folder-nav').addEventListener('contextmenu', (e) => {
  const row = e.target.closest('.folder-row[data-fid]');
  if (!row) return;
  e.preventDefault();
  folderMenu(row.dataset.fid, row.querySelector('.f-more') || row);
});

/* ───────── 웹에 게시 (실시간 공유) ─────────
   - 노트의 공개 사본을 public/{공유ID}에 두고, 로그인 없이 view.html?s=공유ID 로 읽기 전용 열람
   - 본문은 정한 간격(5초·30초·수동)으로 반영, 필기·그림은 저장할 때 바로 반영
   - 자료 파일은 OneDrive에만 두고 링크(이름 + 주소)만 첨부 */
store.setShareResolver((noteId) => state.notes.find((n) => n.id === noteId && !n.trashedAt && !n.locked)?.shareId || null);
const longUrl = (sid) => new URL(`${import.meta.env.BASE_URL}view.html?s=${sid}`, location.origin).href;
// 짧은 주소: youngbaekim.github.io/class/코드 (class 저장소의 안내 쪽이 열람 화면을 띄움). 시험 환경에서는 긴 주소
const SHORT_BASE = 'https://youngbaekim.github.io/class/';
const viewUrl = (sid) => (import.meta.env.PROD && location.hostname === 'youngbaekim.github.io' ? SHORT_BASE + sid : longUrl(sid));
const SHARE_INTERVALS = [[5, '5초마다'], [30, '30초마다'], [0, '수동 (지금 반영 단추)']];
const pubTimers = new Map(); // 노트 ID → 예약 타이머
const lastPub = new Map(); // 노트 ID → 마지막 반영 시각
const pendingPub = new Set(); // 수동 모드에서 아직 반영하지 않은 노트

function publishNow(n) {
  if (!n?.shareId || n.locked || n.trashedAt) return;
  clearTimeout(pubTimers.get(n.id));
  pubTimers.delete(n.id);
  pendingPub.delete(n.id);
  lastPub.set(n.id, Date.now());
  store.publishNote(n.shareId, n);
  renderShareStatus();
}
function schedulePublish(n, now = false) {
  if (!n?.shareId || n.locked || n.trashedAt) return;
  const iv = n.shareInterval ?? 5;
  if (now) return publishNow(n);
  if (iv === 0) { pendingPub.add(n.id); renderShareStatus(); return; }
  if (pubTimers.has(n.id)) return; // 이미 예약됨 (예약 시점에 최신 내용으로 반영)
  const wait = Math.max(0, (lastPub.get(n.id) || 0) + iv * 1000 - Date.now());
  pubTimers.set(n.id, setTimeout(() => publishNow(state.notes.find((x) => x.id === n.id) || n), wait));
}

/** 게시 중지 (askConfirm=false: 휴지통·잠금처럼 이미 확인을 받은 경우) */
async function stopShare(n, refresh = true) {
  const sid = n.shareId;
  if (!sid) return;
  clearTimeout(pubTimers.get(n.id));
  pubTimers.delete(n.id);
  pendingPub.delete(n.id);
  n.shareId = null;
  n.lastShareId = sid; // 다시 게시할 때 같은 주소로
  store.updateFields('notes', n.id, { shareId: null, lastShareId: sid });
  await store.unpublish(sid);
  if (refresh) renderEditorHeader({ keepTitle: true });
}

/** 주소 코드 확인: 비어 있으면 무작위, 이미 쓰는 코드면 이어받기 여부를 물음. 쓸 수 없으면 null */
async function resolveCode(raw, n) {
  if (!raw) return newShareId();
  const code = normCode(raw);
  if (!CODE_RE.test(code)) { alert('주소 코드는 영문 소문자·숫자·하이픈(-)으로 3~20자입니다.\n예: kcce, ai1105, ssu-day1'); return null; }
  const other = state.notes.find((x) => x.shareId === code && x.id !== n.id);
  if (other) {
    if (!confirm(`‘${code}’ 코드는 지금 ‘${titleOf(other)}’ 노트가 쓰고 있습니다.\n그 노트의 게시를 중지하고, 이 노트를 같은 주소로 이어서 게시할까요?\n(열람 중인 화면은 새 노트로 자동으로 바뀝니다)`)) return null;
    await stopShare(other, false);
    return code;
  }
  const info = await store.publicInfo(code);
  if (info.error) { alert('코드를 확인하지 못했습니다. 인터넷 연결을 확인해 주세요.'); return null; }
  if (info.exists && info.owner !== state.user?.uid) { alert(`‘${code}’ 코드는 이미 다른 사람이 쓰고 있습니다. 다른 코드를 정해 주세요.`); return null; }
  if (info.exists) await store.unpublish(code); // 예전에 내가 쓰던 코드의 남은 사본 정리
  return code;
}

const lastCode = () => { try { return localStorage.getItem('yb-last-code') || ''; } catch { return ''; } };
async function startShare(n, name, sid) {
  if (CODE_RE.test(sid) && sid.length <= 20) { try { localStorage.setItem('yb-last-code', sid); } catch { /* 무시 */ } }
  await flushSave();
  n.shareId = sid;
  n.shareName = name || n.shareName || 'YB 노트';
  n.shareInterval = n.shareInterval ?? 5;
  n.attachments = n.attachments || [];
  store.updateFields('notes', n.id, { shareId: sid, shareName: n.shareName, shareInterval: n.shareInterval, attachments: n.attachments });
  lastPub.set(n.id, Date.now());
  await store.publishNote(sid, n);
  await store.copyNoteMedia(sid, n.id);
  renderEditorHeader({ keepTitle: true });
}

const fmtClock = (t) => (t ? new Date(t).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '—');
function renderShareStatus() {
  const el = $('#share-status');
  const n = current();
  if (!el || !n?.shareId) return;
  el.textContent = pendingPub.has(n.id) ? `반영 대기 중 (마지막 반영 ${fmtClock(lastPub.get(n.id))})` : `마지막 반영 ${fmtClock(lastPub.get(n.id))}`;
  el.classList.toggle('wait', pendingPub.has(n.id));
}

async function openShare() {
  let n = current();
  if (!n || n.trashedAt) return;
  if (n.locked) return alert('잠긴 노트는 웹에 게시할 수 없습니다.\n잠금을 해제한 뒤 게시해 주세요.');
  const dlg = $('#share-dlg');
  const body = dlg.querySelector('.share-body');
  const fresh = () => (n = state.notes.find((x) => x.id === n.id) || n); // 동기화로 바뀐 최신 노트 객체
  // 게시 정보 저장 (게시 중이면 열람 화면에 바로 반영, 중지 상태면 저장만)
  const saveMeta = (fields) => {
    fresh();
    Object.assign(n, fields);
    store.updateFields('notes', n.id, fields);
    if (n.shareId) publishNow(n);
  };
  // 자료 링크 목록 — 게시 중이든 중지 상태든 같은 모양으로 보이고 고칠 수 있음
  const attSection = () => {
    const atts = n.attachments || [];
    return `<h4 class="share-h">자료 링크 <small>OneDrive 공유 링크 → 열람 화면의 ‘내려받기’ 단추</small></h4>
      <ul class="att-list">${atts.length ? atts.map((a, i) => `<li class="att-item${a.hidden ? ' off' : ''}" data-i="${i}"><span class="att-grip" title="끌어서 순서 바꾸기" aria-hidden="true">⋮⋮</span><input class="att-name" data-att-name="${i}" value="${esc(a.name)}" maxlength="80" title="눌러서 이름 고치기 (Enter로 저장)" aria-label="자료 이름" /><a class="att-host" href="${esc(a.url)}" target="_blank" rel="noopener" data-nodrag title="링크 열어 보기">${esc(hostLabel(a.url))}</a><button type="button" class="att-pub${a.hidden ? '' : ' on'}" data-nodrag data-att-pub="${i}" aria-pressed="${!a.hidden}" title="${a.hidden ? '열람 화면에 숨김 · 누르면 다시 보이기' : '열람 화면에 보임 · 누르면 숨기기'}">게시</button><button type="button" class="btn-text danger" data-nodrag data-att-del="${i}">삭제</button></li>`).join('') : '<li class="att-empty">첨부한 자료가 없습니다.</li>'}</ul>
      ${atts.length > 1 ? '<p class="hint att-tip">이름은 눌러서 바로 고치고, 줄을 끌어 순서를 바꿉니다(휴대폰은 길게 누른 뒤 끌기). ‘게시’를 끄면 열람 화면에서만 숨겨집니다.</p>' : atts.length ? '<p class="hint att-tip">이름은 눌러서 바로 고칠 수 있습니다. ‘게시’를 끄면 열람 화면에서만 숨겨집니다.</p>' : ''}
      <div class="att-add"><input id="att-name" placeholder="표시 이름 (예: 3주차 강의자료.pdf)" maxlength="80" /><input id="att-url" placeholder="공유 링크 (https://…)" inputmode="url" /><button type="button" class="btn-primary" id="att-add">추가</button></div>
      <p id="att-msg" class="hint"></p>`;
  };
  const bindAtt = () => {
    body.querySelectorAll('[data-att-name]').forEach((inp) => {
      const commit = () => {
        const i = Number(inp.dataset.attName);
        const list = [...(fresh().attachments || [])];
        const name = inp.value.trim();
        if (!list[i]) return;
        if (!name) { inp.value = list[i].name; return; } // 비우면 원래 이름으로
        if (name === list[i].name) return;
        list[i] = { ...list[i], name };
        saveMeta({ attachments: list });
        inp.classList.add('saved');
        setTimeout(() => inp.classList.remove('saved'), 900);
      };
      inp.onchange = commit;
      inp.onkeydown = (e) => {
        if (e.key === 'Enter') { e.preventDefault(); inp.blur(); }
        if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); inp.value = (fresh().attachments || [])[Number(inp.dataset.attName)]?.name || ''; inp.blur(); }
      };
    });
    attDraw = draw;
    ensureAttSortable(body);
    body.querySelectorAll('[data-att-pub]').forEach((b) => (b.onclick = () => {
      const i = Number(b.dataset.attPub);
      const list = [...(fresh().attachments || [])];
      if (!list[i]) return;
      list[i] = { ...list[i], hidden: !list[i].hidden };
      saveMeta({ attachments: list });
      draw();
    }));
    body.querySelectorAll('[data-att-del]').forEach((b) => (b.onclick = () => {
      const list = [...(fresh().attachments || [])];
      list.splice(Number(b.dataset.attDel), 1);
      saveMeta({ attachments: list });
      draw();
    }));
    const add = () => {
      const name = body.querySelector('#att-name').value.trim();
      const link = body.querySelector('#att-url').value.trim();
      const msg = body.querySelector('#att-msg');
      if (!isWebUrl(link)) { msg.textContent = 'https:// 로 시작하는 공유 링크를 넣어 주세요.'; return; }
      saveMeta({ attachments: [...(n.attachments || []), { name: name || hostLabel(link) || '자료', url: link }] });
      draw();
    };
    body.querySelector('#att-add').onclick = add;
    body.querySelector('#att-url').onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); add(); } };
  };
  const draw = async () => {
    fresh();
    if (!n.shareId) {
      body.innerHTML = `
        ${n.lastShareId ? `<div class="share-paused">⏸ 게시 중지됨 · 자료 링크를 점검한 뒤 같은 주소로 다시 게시할 수 있습니다.</div>` : ''}
        <p class="hint" style="margin-top:0">이 노트를 로그인 없이 볼 수 있는 웹 주소로 게시합니다. 고치는 내용이 열람 화면에 자동으로 반영되며, 열람자는 고칠 수 없습니다.</p>
        <ul class="share-notes">
          <li>주소를 아는 사람은 누구나 볼 수 있습니다. 개인정보가 없는지 확인해 주세요.</li>
          <li>자료 파일은 OneDrive에 올린 뒤 ‘링크가 있는 모든 사용자’ 공유 링크를 첨부합니다.</li>
        </ul>
        <label class="share-field">열람 화면 머리말 <input id="share-name" maxlength="40" value="${esc(n.shareName || 'YB 노트')}" /></label>
        <label class="share-field share-code">주소 코드 <span class="code-pre">…/class/</span><input id="share-code" maxlength="20" autocapitalize="off" autocomplete="off" spellcheck="false" placeholder="예: kcce (비우면 무작위)" value="${esc(n.lastShareId || lastCode())}" /></label>
        <p class="hint">특강처럼 주소를 불러 주거나 화면에 띄울 때는 짧은 코드를 정하세요. 코드를 아는 사람은 누구나 볼 수 있으니 공개해도 되는 내용에만 씁니다.</p>
        ${attSection()}
        <div class="row-btns" style="justify-content:flex-end;margin-top:14px">
          <button class="btn-ghost" value="close">닫기</button>
          <button type="button" class="btn-primary" id="share-start">🌐 웹에 게시</button>
        </div>`;
      body.querySelector('#share-start').onclick = async (e) => {
        const btn = e.currentTarget;
        btn.disabled = true;
        btn.textContent = '확인 중…';
        const sid = await resolveCode(body.querySelector('#share-code').value.trim(), fresh());
        if (!sid) { btn.disabled = false; btn.textContent = '🌐 웹에 게시'; return; }
        btn.textContent = '게시 중…';
        await startShare(fresh(), body.querySelector('#share-name').value.trim(), sid);
        draw();
      };
      bindAtt();
      return;
    }
    const url = viewUrl(n.shareId);
    const qr = await QRCode.toDataURL(url, { margin: 1, width: 360, errorCorrectionLevel: 'M' });
    body.innerHTML = `
      <div class="share-live">● 게시 중 <span id="share-status" class="share-status"></span></div>
      <div class="share-url"><input id="share-url" readonly value="${esc(url.replace(/^https:\/\//, ''))}" /><button type="button" class="btn-ghost" id="share-copy">복사</button><a class="btn-ghost" href="${esc(url)}" target="_blank" rel="noopener">열기</a></div>
      <div class="share-qr"><img id="share-qr" src="${qr}" alt="열람 주소 QR 코드" width="132" height="132" />
        <div class="share-opts">
          <label class="share-field">반영 간격 <select id="share-iv">${SHARE_INTERVALS.map(([v, l]) => `<option value="${v}" ${v === (n.shareInterval ?? 5) ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
          <label class="share-field">머리말 <input id="share-name" maxlength="40" value="${esc(n.shareName || 'YB 노트')}" /></label>
          <div class="row-btns"><button type="button" class="btn-ghost" id="share-now">지금 반영</button><button type="button" class="btn-ghost" id="share-big">발표 화면</button></div>
        </div>
      </div>
      ${attSection()}
      <div class="row-btns" style="justify-content:space-between;margin-top:14px">
        <button type="button" class="btn-ghost danger-ghost" id="share-stop">게시 중지</button>
        <button class="btn-ghost" value="close">닫기</button>
      </div>`;
    renderShareStatus();
    body.querySelector('#share-copy').onclick = async (e) => {
      try { await navigator.clipboard.writeText(url); } catch { body.querySelector('#share-url').select(); document.execCommand('copy'); }
      e.currentTarget.textContent = '복사됨';
    };
    body.querySelector('#share-iv').onchange = (e) => {
      const v = Number(e.target.value);
      saveMeta({ shareInterval: v });
    };
    body.querySelector('#share-name').onchange = (e) => saveMeta({ shareName: e.target.value.trim() || 'YB 노트' });
    body.querySelector('#share-now').onclick = async () => { await flushSave(); publishNow(fresh()); };
    body.querySelector('#share-big').onclick = () => showBigQR(qr, url, n.shareName);
    body.querySelector('#share-stop').onclick = async () => {
      if (!confirm('게시를 중지할까요?\n열람 중인 화면에는 ‘게시가 종료되었습니다’가 표시됩니다.\n자료 링크·머리말·코드는 그대로 남아 있어, 점검 후 같은 주소로 다시 게시할 수 있습니다.')) return;
      await stopShare(fresh());
      draw();
    };
    bindAtt();
  };
  await draw();
  if (!dlg.open) dlg.showModal();
}

/** 자료 링크 끌어서 순서 바꾸기 (게시 창이 처음 열릴 때 한 번만 연결) */
let attDraw = null;
let attSortable = false;
function ensureAttSortable(root) {
  if (attSortable) return;
  attSortable = true;
  makeSortable({
    root,
    item: '.att-item',
    targets: '.att-item',
    ghostParent: () => $('#share-dlg'),
    places: () => ['before', 'after'],
    onDrop: (src, t, place) => {
      const n = current();
      if (!n) return;
      const list = [...(n.attachments || [])];
      const from = Number(src.dataset.i);
      let to = Number(t.dataset.i) + (place === 'after' ? 1 : 0);
      const [moved] = list.splice(from, 1);
      if (from < to) to -= 1;
      list.splice(to, 0, moved);
      n.attachments = list;
      store.updateFields('notes', n.id, { attachments: list });
      if (n.shareId) publishNow(n);
      attDraw?.();
    },
  });
}

/** 발표 화면: 프로젝터에 띄울 큰 주소 + QR */
function showBigQR(src, url, name) {
  const ov = document.createElement('div');
  ov.className = 'qr-big';
  const plain = url.replace(/^https?:\/\//, '');
  const cut = plain.includes('?s=') ? plain.indexOf('?s=') + 3 : plain.lastIndexOf('/') + 1;
  ov.innerHTML = `<p class="qb-name">${esc(name || '')}</p>
    <p class="qb-url">${esc(plain.slice(0, cut))}<b>${esc(plain.slice(cut))}</b></p>
    <img src="${src}" alt="QR 코드" />
    <small>브라우저 주소창에 위 주소를 입력하세요 · 아무 곳이나 누르면 닫힘</small>`;
  ov.onclick = () => ov.remove();
  ($('#share-dlg').open ? $('#share-dlg') : document.body).appendChild(ov);
}

/* ───────── HTML 노트: 가져오기·편집 도구·내보내기 (v0.9.0) ───────── */
async function readHtmlFile(file) {
  const raw = await file.text();
  if (raw.startsWith('%PDF') || raw.slice(0, 4096).includes('\u0000')) { // HTML이 아닌 파일 (예: PDF)
    alert(`‘${file.name}’은(는) HTML 파일이 아닙니다.`);
    return null;
  }
  const html = sanitizeHtml(raw);
  if (byteSize(html) > HTML_MAX) {
    alert(`‘${file.name}’은(는) 저장 가능한 크기(약 900KB)를 넘습니다.\n문서 안에 넣은 그림을 줄이거나 빼고 다시 가져와 주세요.`);
    return null;
  }
  const title = htmlTitle(html) || file.name.replace(/\.html?$/i, '');
  return { html, title };
}

/** 새 HTML 노트로 가져오기 */
async function importHtmlFile(file) {
  const r = await readHtmlFile(file);
  if (!r) return;
  await flushSave();
  const folderId = SYS_FILTERS.includes(state.filter) ? null : state.filter;
  const now = Date.now();
  const note = {
    id: store.newId('note'),
    type: 'html',
    title: r.title,
    html: r.html,
    content: null,
    preview: htmlText(r.html).slice(0, 120),
    folderId,
    fav: state.filter === 'fav',
    trashedAt: null,
    order: Math.min(0, ...state.notes.map(noteOrder)) - 1000,
    createdAt: now,
    updatedAt: now,
  };
  note.tags = tagsOf(note.title);
  store.saveNote(note);
  state.notes.unshift(note);
  await openNote(note.id);
  setSaveState('HTML 가져옴');
}

/** 비어 있는 노트인지 (제목은 있어도 본문이 없으면 빈 노트) */
function isEmptyNote(n) {
  if (!n || isHtml(n)) return false;
  if (n.id === state.noteId && !$('#editor').hidden) return editor.isEmpty;
  return !/"type":"(text|image|drawing)"/.test(JSON.stringify(n.content || {}));
}

/** 노트 화면에 HTML 파일을 끌어 놓았을 때
 *  - 빈 노트: 그 노트를 HTML 노트로 (가져오기와 같음)
 *  - 내용이 있는 노트: 새 노트로 열기 / 취소 */
async function dropHtmlOnNote(file) {
  const n = current();
  if (!n || n.trashedAt) return importHtmlFile(file);
  if (n.locked && !isUnlocked()) return;
  if (isHtml(n)) {
    if (!confirm(`HTML 노트에는 다른 문서를 덧붙일 수 없습니다.\n‘${file.name}’을(를) 새 노트로 열까요?\n\n[확인] 새 노트로 열기   [취소] 가져오지 않음`)) return;
    return importHtmlFile(file);
  }
  if (!isEmptyNote(n)) return appendHtmlToNote(file); // 내용이 있으면 맨 아래에 HTML 문서 칸
  const r = await readHtmlFile(file);
  if (!r) return;
  clearTimeout(saveTimer);
  dirty = false;
  const title = ($('#note-title').value || '').trim() || r.title;
  n.type = 'html';
  n.html = r.html;
  n.content = null;
  n.title = title;
  n.tags = tagsOf(title);
  n.preview = htmlText(r.html).slice(0, 120);
  n.updatedAt = Date.now();
  store.saveNote(n);
  schedulePublish(n, true);
  await openNote(null);
  await openNote(n.id);
  setSaveState('HTML 가져옴');
}
const htmlFileOf = (dt) => [...(dt?.files || [])].find((f) => /\.html?$/i.test(f.name) || f.type === 'text/html');
const hasFileDrag = (dt) => [...(dt?.items || [])].some((i) => i.kind === 'file') || [...(dt?.types || [])].includes('Files');
// 노트 화면(편집기·빈 화면)에 끌어 놓기 — 그림 끌어 놓기보다 먼저 가로챔 (HTML 파일일 때만)
$('.pane-editor').addEventListener('dragover', (e) => {
  if (!hasFileDrag(e.dataTransfer)) return;
  e.preventDefault(); // 빈 화면에도 놓을 수 있도록
  $('.pane-editor').classList.add('drop-file');
}, true);
$('.pane-editor').addEventListener('dragleave', (e) => { if (!e.relatedTarget || !$('.pane-editor').contains(e.relatedTarget)) $('.pane-editor').classList.remove('drop-file'); }, true);
$('.pane-editor').addEventListener('drop', async (e) => {
  $('.pane-editor').classList.remove('drop-file');
  const files = [...(e.dataTransfer?.files || [])].filter((f) => isPdfFile(f) || isHtmlFile(f) || (!f.type && !/\.(png|jpe?g|gif|webp|heic|bmp)$/i.test(f.name)));
  if (!files.length) return; // 그림 등은 원래대로
  e.preventDefault();
  e.stopPropagation();
  await handleFiles(files, 'note');
}, true);
// 끌어 놓을 자리 표시가 남지 않도록
document.addEventListener('drop', () => document.querySelectorAll('.drop-file').forEach((x) => x.classList.remove('drop-file')));
document.addEventListener('dragend', () => document.querySelectorAll('.drop-file').forEach((x) => x.classList.remove('drop-file')));

/** HTML 노트 도구 모음 (일반 노트 도구 모음 대신 표시) */
function renderHtmlBar() {
  const n = current();
  const bar = $('#html-bar');
  const show = isHtml(n) && !(n.locked && !isUnlocked());
  bar.hidden = !show;
  if (!show) return;
  const editing = htmlView.isEditing();
  const btn = $('#hb-edit');
  btn.textContent = editing ? '✓ 편집 끝내기' : '✎ 편집';
  btn.classList.toggle('on', editing);
  btn.disabled = !!n.trashedAt;
  bar.classList.toggle('editing', editing);
  bar.querySelectorAll('[data-hx]').forEach((b) => (b.disabled = !editing));
}
$('#hb-edit').addEventListener('click', async () => {
  const on = !htmlView.isEditing();
  if (!on) await flushSave();
  htmlView.setEditing(on);
  renderHtmlBar();
  setSaveState(on ? '편집 중' : '저장됨');
});
$('#html-bar').addEventListener('mousedown', (e) => { if (e.target.closest('button')) e.preventDefault(); });
$('#html-bar').addEventListener('click', (e) => {
  const b = e.target.closest('[data-hx]');
  if (!b) return;
  const [cmd, val] = b.dataset.hx.split(':');
  if (cmd === 'removeFormat') { htmlView.exec('removeFormat'); return; }
  htmlView.exec(cmd, val || null);
});

/** 내보내기: PDF(모든 노트) · HTML 파일(HTML 노트) */
function exportMenu(anchor) {
  const n = current();
  if (!n) return;
  const menu = $('#ctx-menu');
  menu.innerHTML = `
    <button data-ex="pdf">📄 PDF로 저장 <small>(인쇄 창에서 ‘PDF로 저장’)</small></button>
    ${isHtml(n) ? '<button data-ex="html">🌐 HTML 파일로 저장</button>' : ''}`;
  const r = anchor.getBoundingClientRect();
  menu.hidden = false;
  menu.style.left = `${Math.max(8, Math.min(r.right - 240, window.innerWidth - 248))}px`;
  menu.style.top = `${r.bottom + 4}px`;
  menu.onclick = (e) => {
    const act = e.target.closest('[data-ex]')?.dataset.ex;
    menu.hidden = true;
    if (act === 'pdf') printNote();
    if (act === 'html') exportHtml(n);
  };
}
async function exportHtml(n) {
  await flushSave();
  const name = `${(stripTags(n.title) || 'YB 노트').replace(/[\\/:*?"<>|]/g, ' ').trim()}.html`;
  const url = URL.createObjectURL(new Blob([n.html || ''], { type: 'text/html;charset=utf-8' }));
  const a = Object.assign(document.createElement('a'), { href: url, download: name });
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
  setSaveState('HTML 저장됨');
}

/* ───────── PDF 가져오기 (v0.9.2) ─────────
   - 새 노트·빈 노트: 첫 쪽부터 / 내용이 있는 노트: 맨 아래에 이어서
   - 쪽마다 고화질 그림(용지 폭 전체) + 쪽의 글자는 검색용으로 함께 저장 */
const isPdfFile = (f) => !!f && (f.type === 'application/pdf' || /\.pdf$/i.test(f.name || ''));
const isHtmlFile = (f) => !!f && (/\.html?$/i.test(f.name || '') || f.type === 'text/html');
const PDF_ASK_PAGES = 30;
let pdfBusy = false;

function pdfProgressUI() {
  let box = $('#pdf-progress');
  if (!box) {
    box = document.createElement('div');
    box.id = 'pdf-progress';
    box.className = 'pdf-progress';
    box.innerHTML = `<div class="pp-card"><b class="pp-title">PDF 가져오는 중…</b><div class="pp-bar"><i></i></div><span class="pp-count"></span><button type="button" class="btn-ghost pp-stop">그만두기</button></div>`;
    $('.pane-editor').appendChild(box);
  }
  return box;
}

async function newNoteForFile(title) {
  await newNote();
  const n = current();
  $('#note-title').value = title;
  n.title = title;
  n.tags = tagsOf(title);
  store.updateFields('notes', n.id, { title, tags: n.tags });
  renderList();
  return n;
}

/** PDF를 노트에 넣기. target: 'auto'(드롭 규칙) | 'new'(항상 새 노트) */
async function addPdf(file, target = 'auto') {
  if (pdfBusy) return alert('다른 PDF를 가져오는 중입니다. 끝난 뒤 다시 시도해 주세요.');
  const base = file.name.replace(/\.pdf$/i, '');
  let n = current();
  if (target === 'new' || !n || n.trashedAt || isHtml(n)) n = await newNoteForFile(base);
  else if (n.locked && !isUnlocked()) return;
  else {
    await flushSave();
    if (!($('#note-title').value || '').trim()) { $('#note-title').value = base; scheduleSave(); }
  }
  const startId = n.id;
  pdfBusy = true;
  let stop = false;
  const ui = pdfProgressUI();
  ui.hidden = false;
  ui.querySelector('.pp-stop').onclick = () => { stop = true; ui.querySelector('.pp-title').textContent = '그만두는 중…'; };
  ui.querySelector('.pp-title').textContent = `‘${file.name}’ 가져오는 중…`;
  ui.querySelector('.pp-count').textContent = 'PDF 여는 중';
  ui.querySelector('.pp-bar i').style.width = '0%';
  try {
    const done = await editor.appendPdfFile(file, {
      isCancelled: () => stop || state.noteId !== startId,
      confirmPages: (total) => total <= PDF_ASK_PAGES || confirm(`이 PDF는 ${total}쪽입니다.\n쪽마다 고화질 그림(쪽당 약 150~600KB)으로 저장되어 시간이 걸리고 저장 공간을 많이 씁니다.\n계속할까요?`),
      onProgress: (i, total) => {
        ui.querySelector('.pp-count').textContent = `${i} / ${total}쪽`;
        ui.querySelector('.pp-bar i').style.width = `${Math.round(((i - 1) / total) * 100)}%`;
        setSaveState(`PDF ${i}/${total}쪽`);
      },
    });
    scheduleSave(true);
    setSaveState(done ? `PDF ${done}쪽 가져옴` : '가져오지 않음');
  } catch (err) {
    console.error('[YB-EverNote] PDF 가져오기 실패', err);
    alert(/password/i.test(err?.name || err?.message || '') ? '암호가 걸린 PDF는 가져올 수 없습니다.' : 'PDF를 읽지 못했습니다. 파일이 손상되었거나 지원하지 않는 형식일 수 있습니다.');
    setSaveState('');
  } finally {
    pdfBusy = false;
    ui.hidden = true;
  }
}

/** 노트 화면에 HTML을 끌어 놓았을 때 (내용이 있는 일반 노트 → 맨 아래에 HTML 문서 칸) */
async function appendHtmlToNote(file) {
  const n = current();
  if (n.locked && !isUnlocked()) return;
  if (await editor.appendHtmlFile(file)) { scheduleSave(true); setSaveState('HTML 문서 칸 추가'); }
}

/** 여러 파일 한꺼번에: 순서대로 처리 */
/** 파일 종류를 이름이 아니라 내용 앞부분으로 확인
 *  (안드로이드 파일 선택기는 이름·형식 정보를 비워 보내는 경우가 있음) */
async function sniffFile(f) {
  let head = '';
  try { head = await f.slice(0, 2048).text(); } catch { /* 무시 */ }
  if (head.startsWith('%PDF')) return 'pdf';
  if (head.includes('\u0000')) return isPdfFile(f) ? 'pdf' : 'other'; // 이진 파일
  if (isHtmlFile(f) || /<!doctype html|<html[\s>]|<head[\s>]|<body[\s>]/i.test(head)) return 'html';
  return isPdfFile(f) ? 'pdf' : 'other';
}
async function handleFiles(files, where) {
  for (const f of files) {
    const kind = await sniffFile(f);
    if (kind === 'pdf') await addPdf(f, where === 'list' ? 'new' : 'auto');
    else if (kind === 'html') await (where === 'list' ? importHtmlFile(f) : dropHtmlOnNote(f));
    else alert(`‘${f.name || '선택한 파일'}’은(는) PDF나 HTML 파일이 아니어서 가져오지 않았습니다.`);
  }
}

/* ───────── 인쇄·PDF ───────── */
async function printNote() {
  resetZoom(); // 확대한 필기는 원래 크기로 인쇄 (노트 배율은 인쇄용 스타일에서 100%)
  await flushAllDrawings();
  await flushSave();
  const n = current();
  if (!n) return;
  if (isHtml(n)) return htmlView.print(); // HTML 노트는 문서 자체를 인쇄 (원본 쪽 구분 그대로)
  $('#print-title').textContent = stripTags(n.title) || titleOf(n);
  const prev = document.title;
  document.title = (stripTags(n.title) || 'YB-EverNote').replace(/[\\/:*?"<>|]/g, ' ');
  window.print(); // 인쇄 창에서 '대상: PDF로 저장'을 고르면 PDF 파일
  document.title = prev;
}

/* ───────── 백업·복원 ───────── */
/* 백업 알림 규칙
   - 마지막 백업 날짜는 계정 설정에 저장 → 어느 기기에서든 한 번 백업하면 모든 기기에 적용
   - 마지막 백업 후 7일이 지나면 알림, '나중에'를 누르면 15일간 다시 묻지 않음 (이것도 계정 단위)
   - 휴대폰에서는 알림을 띄우지 않음 (백업 파일 보관이 불편하므로 PC·태블릿에서) */
const BACKUP_KEY = () => `yb-last-backup-${state.user?.uid}`; // 이전 버전(기기별 기록) 호환용
const BACKUP_EVERY = 7 * DAY;
const BACKUP_SNOOZE = 15 * DAY;
let settingsLoaded = false;
function lastBackupAt() {
  let local = 0;
  try { local = Number(localStorage.getItem(BACKUP_KEY()) || 0); } catch { /* 무시 */ }
  return Math.max(Number(state.settings.lastBackupAt) || 0, local);
}
const isPhone = () => Math.min(screen.width, screen.height) < 600 || window.innerWidth <= 680;
function lastBackupText() {
  const t = lastBackupAt();
  if (!t) return '백업한 적 없음';
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
    state.settings = { ...state.settings, lastBackupAt: Date.now(), backupSnoozeUntil: null };
    store.saveSettings(state.settings); // 계정 단위 기록 → 다른 기기 알림도 함께 멈춤
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
  if (!settingsLoaded || isPhone() || state.notes.length < 3) return;
  const now = Date.now();
  const t = lastBackupAt();
  if (t && now - t < BACKUP_EVERY) return;
  if (Number(state.settings.backupSnoozeUntil) > now) return;
  const toast = $('#toast');
  if (!toast.hidden) return;
  const days = t ? Math.floor((now - t) / DAY) : 0;
  toast.innerHTML = `${t ? `마지막 백업 후 ${days}일이 지났습니다.` : '아직 백업 파일이 없습니다.'} <button class="btn-text" id="btn-backup-now">지금 백업</button><button class="btn-text" id="btn-backup-later">나중에 (15일 뒤 다시)</button>`;
  toast.hidden = false;
  $('#btn-backup-now').onclick = () => { toast.hidden = true; doBackup(); };
  $('#btn-backup-later').onclick = () => {
    toast.hidden = true;
    state.settings = { ...state.settings, backupSnoozeUntil: now + BACKUP_SNOOZE };
    store.saveSettings(state.settings);
  };
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
  applyTopGap();
  watchAuth((user) => (user ? onSignedIn(user) : onSignedOut()));
  if (navigator.storage?.persist) navigator.storage.persist().catch(() => {});
})();
