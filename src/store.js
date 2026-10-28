// 저장소 계층 — 3단계: Firestore (users/{uid}/…)
// 쓰기는 기기 안 사본에 먼저 반영되고, 온라인이 되면 서버로 자동 전송됩니다.
// 따라서 쓰기 함수는 서버 응답을 기다리지 않습니다(오프라인에서도 바로 다음 작업 가능).
import {
  collection, doc, setDoc, updateDoc, deleteDoc, onSnapshot, query, where, getDocs, getDoc, getDocFromCache,
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
    }, (err) => {
      report('노트 동기화')(err);
      if (err?.code === 'permission-denied') h.onDenied?.(); // 보안 규칙에서 허용되지 않은 계정
    })
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

/* ───────── 일부 항목만 고치기 (순서 변경 등: 본문을 다시 쓰지 않음) ───────── */
export function updateFields(name, id, fields) {
  updateDoc(ref(name, id), clean({ ...fields, updatedBy: DEVICE_ID })).catch(report('순서 저장'));
}
export function updateMany(name, list) {
  for (let i = 0; i < list.length; i += 400) {
    const batch = writeBatch(fs);
    list.slice(i, i + 400).forEach(({ id, fields }) => batch.update(ref(name, id), clean({ ...fields, updatedBy: DEVICE_ID })));
    batch.commit().catch(report('순서 저장'));
  }
}

/* ───────── 폴더 ───────── */
export function saveFolder(folder) {
  const { id, ...rest } = folder;
  setDoc(ref('folders', id), clean(rest)).catch(report('폴더 저장'));
  return folder;
}

/** 폴더 삭제: 안의 노트는 '미분류'로 이동 */
/** 폴더 삭제: 안의 노트와 하위 폴더는 상위 폴더(없으면 '미분류'·최상위)로 이동 */
export async function deleteFolder(id, { notes = [], subfolders = [], parentId = null } = {}) {
  const batch = writeBatch(fs);
  const now = Date.now();
  for (const n of notes) batch.update(ref('notes', n.id), { folderId: parentId, updatedAt: now, updatedBy: DEVICE_ID });
  for (const f of subfolders) batch.update(ref('folders', f.id), { parentId, updatedAt: now });
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
  for (const name of ['images', 'chunks', 'versions']) {
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

/* ───────── 이전 버전 (덮어쓰기 대비) ───────── */
const KEEP_VERSIONS = 20; // 노트마다 최근 20개만 보관

/** 지금 내용을 이전 버전으로 보관. reason: auto(일정 시간마다) · other(다른 기기 내용을 덮어쓰기 전) · restore(복원 직전) */
export function putVersion(noteId, { title, content }, reason) {
  const id = newId('ver');
  setDoc(ref('versions', id), clean({
    noteId, title: title || '', contentJson: content ? JSON.stringify(content) : '',
    reason, device: DEVICE_ID, savedAt: Date.now(),
  })).catch(report('이전 버전 저장'));
  pruneVersions(noteId);
}

async function pruneVersions(noteId) {
  try {
    const snap = await getDocs(query(col('versions'), where('noteId', '==', noteId)));
    const extra = snap.docs.sort((a, b) => b.data().savedAt - a.data().savedAt).slice(KEEP_VERSIONS);
    if (!extra.length) return;
    const batch = writeBatch(fs);
    extra.forEach((d) => batch.delete(d.ref));
    batch.commit().catch(report('이전 버전 정리'));
  } catch (err) {
    report('이전 버전 정리')(err);
  }
}

export async function listVersions(noteId) {
  const snap = await getDocs(query(col('versions'), where('noteId', '==', noteId)));
  return snap.docs
    .map((d) => {
      const v = d.data();
      let content = null;
      try { content = v.contentJson ? JSON.parse(v.contentJson) : null; } catch { /* 무시 */ }
      return { ...v, id: d.id, content };
    })
    .sort((a, b) => b.savedAt - a.savedAt);
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

/** 필기 블록의 묶음 구독: 처음에는 전체, 이후 새로 생긴 묶음만 전달
 *  cb(added, { fromCache, docs }) — docs: 지금 있는 묶음 전체의 { id, createdAt } (묶음 정리에 사용) */
export function subscribeChunks(drawingId, cb) {
  if (!uid) return () => {};
  return onSnapshot(
    query(col('chunks'), where('drawingId', '==', drawingId)),
    { includeMetadataChanges: true },
    (snap) => {
      const added = snap
        .docChanges()
        .filter((c) => c.type === 'added')
        .map((c) => ({ ...c.doc.data(), id: c.doc.id }))
        .sort((a, b) => a.createdAt - b.createdAt || (a.seq ?? 0) - (b.seq ?? 0));
      const info = {
        fromCache: snap.metadata.fromCache,
        pending: snap.metadata.hasPendingWrites,
        docs: snap.docs.map((d) => ({ id: d.id, createdAt: d.data().createdAt || 0 })),
      };
      cb(added, info);
    },
    report('필기 동기화')
  );
}

/** 묶음 정리: 지금 남아 있는 획만 새 묶음으로 다시 쓰고, 예전 묶음(지운 획 기록 포함)은 한 번에 삭제
 *  - 새 묶음과 삭제를 한 묶음 쓰기(batch)로 처리 → 중간에 끊겨도 반쯤 정리된 상태가 생기지 않음
 *  - 새 묶음의 작성 시각은 예전 묶음 중 가장 늦은 시각 (이후에 다른 기기가 쓴 기록이 뒤에 적용되도록) */
export function compactChunks({ drawingId, noteId, records, oldIds, createdAt, maxChars }) {
  const parts = [];
  let cur = [];
  let chars = 0;
  for (const rec of records) {
    const len = (rec.pts?.length || 0) + 80;
    if (chars + len > maxChars && cur.length) { parts.push(cur); cur = []; chars = 0; }
    cur.push(rec);
    chars += len;
  }
  if (cur.length) parts.push(cur);
  if (parts.length + oldIds.length > 480) return null; // 한 번에 처리할 수 없는 양이면 정리하지 않음
  const stamp = Date.now().toString(36);
  const batch = writeBatch(fs);
  const ids = parts.map((strokes, i) => {
    const id = `${drawingId}_compact_${stamp}_${i}`;
    batch.set(ref('chunks', id), clean({ drawingId, noteId, device: 'compact', seq: 0, strokes, erased: [], createdAt }));
    return id;
  });
  oldIds.forEach((id) => batch.delete(ref('chunks', id)));
  batch.commit().catch(report('필기 묶음 정리'));
  return ids;
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
    // 이 기기에서 이미 다른 계정으로 옮기거나 건너뛴 적이 있으면 묻지 않음 (가족이 같은 기기를 쓸 때 남의 옛 노트가 섞이지 않게)
    if (Object.keys(localStorage).some((k) => k.startsWith('yb-migrated-'))) return null;
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

/* ───────── 백업·복원 ───────── */
const toB64 = (u8) => {
  let s = '';
  for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode(...u8.subarray(i, i + 0x8000));
  return btoa(s);
};
const fromB64 = (b64) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));

/** 계정의 모든 데이터를 파일 하나로 (그림은 base64) */
export async function exportAllCloud() {
  const all = async (name) => (await getDocs(col(name))).docs.map((d) => ({ ...d.data(), id: d.id }));
  const [folders, notesRaw, chunks, imagesRaw, versions] = await Promise.all([all('folders'), all('notes'), all('chunks'), all('images'), all('versions')]);
  const settingsDoc = await getDoc(ref('settings', 'app'));
  const notes = notesRaw.map(({ contentJson, ...n }) => {
    let content = null;
    try { content = contentJson ? JSON.parse(contentJson) : null; } catch { /* 무시 */ }
    return { ...n, content };
  });
  const images = imagesRaw.map(({ data, ...img }) => ({ ...img, dataB64: data ? toB64(data.toUint8Array()) : '' }));
  return {
    app: 'YB-EverNote',
    format: 1,
    exportedAt: new Date().toISOString(),
    folders,
    notes,
    chunks,
    images,
    versions,
    settings: settingsDoc.exists() ? settingsDoc.data().value : null,
  };
}

/** 백업 파일 복원: 같은 ID는 덮어쓰고, 백업 이후 새로 만든 것은 그대로 둠 */
export async function importAll(data) {
  const ops = [];
  (data.folders || []).forEach(({ id, ...r }) => ops.push(['folders', id, clean(r)]));
  (data.notes || []).forEach((n) => ops.push(['notes', n.id, noteToDoc(n)]));
  (data.chunks || []).forEach(({ id, ...r }) => ops.push(['chunks', id, clean(r)]));
  (data.versions || []).forEach(({ id, ...r }) => ops.push(['versions', id, clean(r)]));
  if (data.settings) ops.push(['settings', 'app', { value: clean(data.settings), updatedAt: Date.now() }]);
  for (let i = 0; i < ops.length; i += 200) {
    const batch = writeBatch(fs);
    ops.slice(i, i + 200).forEach(([c, id, d]) => batch.set(ref(c, id), d));
    batch.commit().catch(report('복원'));
  }
  for (const { id, dataB64, ...meta } of data.images || []) {
    if (!dataB64) continue;
    setDoc(ref('images', id), { ...clean(meta), data: Bytes.fromUint8Array(fromB64(dataB64)) }).catch(report('그림 복원'));
  }
}
