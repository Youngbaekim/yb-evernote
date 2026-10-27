// 저장소 계층 — 3단계: Firestore (users/{uid}/…)
// 쓰기는 기기 안 사본에 먼저 반영되고, 온라인이 되면 서버로 자동 전송됩니다.
// 따라서 쓰기 함수는 서버 응답을 기다리지 않습니다(오프라인에서도 바로 다음 작업 가능).
import {
  collection, doc, setDoc, deleteDoc, onSnapshot, query, where, getDocs, getDoc, getDocFromCache,
  writeBatch, Bytes, getAggregateFromServer, count, sum,
} from 'firebase/firestore';
import { fs } from './firebase.js';
import { DEVICE_ID } from './device.js';
import * as local from './db.js';

export const newId = local.newId;

let uid = null;
const unsubs = [];

const col = (name) => collection(fs, 'users', uid, name);
const ref = (name, id) => doc(fs, 'users', uid, name, id);
/** Firestore는 undefined 값을 받지 않으므로 정리 */
const clean = (o) => JSON.parse(JSON.stringify(o));
const report = (what) => (err) => console.error(`[YB-EverNote] ${what} 실패`, err);

/* ───────── 노트 형식 변환 ───────── */
function noteToDoc(n) {
  const { id, content, ...rest } = n;
  return clean({ ...rest, contentJson: content ? JSON.stringify(content) : '', updatedBy: DEVICE_ID });
}
function docToNote(d) {
  const data = d.data();
  const { contentJson, ...rest } = data;
  let content = null;
  try { content = contentJson ? JSON.parse(contentJson) : null; } catch { content = null; }
  return { ...rest, id: d.id, content };
}

/* ───────── 동기화 시작·종료 ───────── */
/**
 * @param {string} userId
 * @param {{ onFolders, onNotes, onSettings, onStatus }} h
 */
export function startSync(userId, h) {
  stopSync();
  uid = userId;
  let pending = { notes: false, folders: false };
  const status = (fromCache) => h.onStatus?.({ pending: pending.notes || pending.folders, fromCache });

  unsubs.push(
    onSnapshot(col('folders'), { includeMetadataChanges: true }, (snap) => {
      pending.folders = snap.metadata.hasPendingWrites;
      const list = snap.docs.map((d) => ({ ...d.data(), id: d.id }));
      list.sort((a, b) => (a.order ?? 0) - (b.order ?? 0) || a.createdAt - b.createdAt);
      h.onFolders(list);
      status(snap.metadata.fromCache);
    }, report('폴더 동기화'))
  );

  unsubs.push(
    onSnapshot(col('notes'), { includeMetadataChanges: true }, (snap) => {
      pending.notes = snap.metadata.hasPendingWrites;
      const list = snap.docs.map(docToNote).sort((a, b) => b.updatedAt - a.updatedAt);
      // 다른 기기에서 바뀐 노트(이 기기의 미전송 변경이 아닌 것)
      const remote = snap
        .docChanges()
        .filter((c) => c.type === 'modified' && !c.doc.metadata.hasPendingWrites && c.doc.data().updatedBy !== DEVICE_ID)
        .map((c) => c.doc.id);
      h.onNotes(list, remote);
      status(snap.metadata.fromCache);
    }, report('노트 동기화'))
  );

  unsubs.push(
    onSnapshot(ref('settings', 'app'), (d) => {
      if (d.exists()) h.onSettings({ ...local.DEFAULT_SETTINGS, ...(d.data().value || {}) });
    }, report('설정 동기화'))
  );
}

export function stopSync() {
  while (unsubs.length) unsubs.pop()();
  uid = null;
}

/* ───────── 폴더 ───────── */
export function saveFolder(folder) {
  const { id, ...rest } = folder;
  setDoc(ref('folders', id), clean(rest)).catch(report('폴더 저장'));
  return folder;
}

/** 폴더 삭제: 안의 노트는 '미분류'로 이동 */
export async function deleteFolder(id, notesInFolder) {
  const batch = writeBatch(fs);
  for (const n of notesInFolder) batch.update(ref('notes', n.id), { folderId: null, updatedAt: Date.now(), updatedBy: DEVICE_ID });
  batch.delete(ref('folders', id));
  batch.commit().catch(report('폴더 삭제'));
}

/* ───────── 노트 ───────── */
export function saveNote(note) {
  setDoc(ref('notes', note.id), noteToDoc(note)).catch(report('노트 저장'));
  return note;
}

/** 영구 삭제: 노트와 그 노트의 그림·필기 묶음 */
export async function purgeNote(id) {
  const refs = [ref('notes', id)];
  for (const name of ['images', 'chunks']) {
    try {
      const snap = await getDocs(query(col(name), where('noteId', '==', id)));
      snap.forEach((d) => refs.push(d.ref));
    } catch (err) {
      report(`${name} 조회`)(err);
    }
  }
  for (let i = 0; i < refs.length; i += 400) {
    const batch = writeBatch(fs);
    refs.slice(i, i + 400).forEach((r) => batch.delete(r));
    batch.commit().catch(report('노트 영구 삭제'));
  }
}

/* ───────── 그림 ───────── */
export async function putImage({ id, blob, ...meta }) {
  const bytes = Bytes.fromUint8Array(new Uint8Array(await blob.arrayBuffer()));
  const data = { ...clean(meta), data: bytes, createdAt: meta.createdAt ?? Date.now() };
  setDoc(ref('images', id), data).catch(report('그림 저장'));
}

export async function getImage(id) {
  let d;
  try { d = await getDocFromCache(ref('images', id)); } catch { d = null; }
  if (!d?.exists()) {
    try { d = await getDoc(ref('images', id)); } catch (err) { report('그림 불러오기')(err); return null; }
  }
  if (!d.exists()) return null;
  const v = d.data();
  return { ...v, id, blob: new Blob([v.data.toUint8Array()], { type: v.mime || 'image/webp' }) };
}

/** 그림 사용량 (서버 집계, 온라인일 때만) */
export async function imageUsage() {
  try {
    const s = await getAggregateFromServer(col('images'), { n: count(), bytes: sum('size') });
    return { count: s.data().n, bytes: s.data().bytes || 0 };
  } catch {
    return null;
  }
}

/* ───────── 필기 획 묶음 ───────── */
export function putChunk(chunk) {
  const { id, ...rest } = chunk;
  setDoc(ref('chunks', id), clean(rest)).catch(report('필기 저장'));
  return chunk;
}

/** 필기 블록의 묶음 구독: 처음에는 전체, 이후 새로 생긴 묶음만 전달 */
export function subscribeChunks(drawingId, cb) {
  if (!uid) return () => {};
  return onSnapshot(
    query(col('chunks'), where('drawingId', '==', drawingId)),
    (snap) => {
      const added = snap
        .docChanges()
        .filter((c) => c.type === 'added')
        .map((c) => ({ ...c.doc.data(), id: c.doc.id }))
        .sort((a, b) => a.createdAt - b.createdAt || (a.seq ?? 0) - (b.seq ?? 0));
      if (added.length) cb(added);
    },
    report('필기 동기화')
  );
}

/* ───────── 설정 ───────── */
export const DEFAULT_SETTINGS = local.DEFAULT_SETTINGS;
export function saveSettings(value) {
  setDoc(ref('settings', 'app'), { value: clean(value), updatedAt: Date.now() }).catch(report('설정 저장'));
  return value;
}

/* ───────── 1·2단계 기기 저장분 → 계정으로 옮기기 ───────── */
const migratedKey = () => `yb-migrated-${uid}`;

export async function localDataSummary() {
  try {
    if (localStorage.getItem(migratedKey())) return null;
  } catch { /* 무시 */ }
  const all = await local.exportAll();
  const n = all.notes.length + all.folders.length;
  return n ? all : null;
}

export async function migrateLocal(all, onProgress) {
  const ops = [];
  all.folders.forEach((f) => { const { id, ...r } = f; ops.push(['folders', id, clean(r)]); });
  all.notes.forEach((n) => ops.push(['notes', n.id, noteToDoc(n)]));
  all.chunks.forEach((c) => { const { id, ...r } = c; ops.push(['chunks', id, clean(r)]); });
  if (all.settings) ops.push(['settings', 'app', { value: clean(all.settings), updatedAt: Date.now() }]);
  for (let i = 0; i < ops.length; i += 200) {
    const batch = writeBatch(fs);
    ops.slice(i, i + 200).forEach(([c, id, data]) => batch.set(ref(c, id), data));
    batch.commit().catch(report('기존 노트 옮기기'));
    onProgress?.(Math.min(i + 200, ops.length), ops.length + all.images.length);
  }
  // 그림은 크기가 커서 한 건씩
  for (let i = 0; i < all.images.length; i++) {
    await putImage(all.images[i]);
    onProgress?.(ops.length + i + 1, ops.length + all.images.length);
  }
  try { localStorage.setItem(migratedKey(), String(Date.now())); } catch { /* 무시 */ }
}

export function skipMigration() {
  try { localStorage.setItem(migratedKey(), 'skipped'); } catch { /* 무시 */ }
}
