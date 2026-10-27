// 저장소 계층 — 1단계: 기기 내 IndexedDB
// 3단계에서 같은 함수 이름을 유지한 채 Firestore 연동으로 확장합니다.
import { openDB } from 'idb';

const DB_NAME = 'yb-evernote';
const DB_VERSION = 1;

let dbPromise;
function db() {
  if (!dbPromise) {
    dbPromise = openDB(DB_NAME, DB_VERSION, {
      upgrade(d) {
        d.createObjectStore('folders', { keyPath: 'id' });
        const notes = d.createObjectStore('notes', { keyPath: 'id' });
        notes.createIndex('folderId', 'folderId');
        const images = d.createObjectStore('images', { keyPath: 'id' });
        images.createIndex('noteId', 'noteId');
      },
    });
  }
  return dbPromise;
}

export const newId = (prefix) =>
  `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;

/* ── 폴더 ── */
export async function listFolders() {
  const all = await (await db()).getAll('folders');
  return all.sort((a, b) => a.order - b.order || a.createdAt - b.createdAt);
}
export async function saveFolder(folder) {
  await (await db()).put('folders', folder);
  return folder;
}
/** 폴더 삭제: 안의 노트는 지우지 않고 '미분류'로 이동 */
export async function deleteFolder(id) {
  const d = await db();
  const tx = d.transaction(['folders', 'notes'], 'readwrite');
  const notes = await tx.objectStore('notes').index('folderId').getAll(id);
  for (const n of notes) {
    n.folderId = null;
    await tx.objectStore('notes').put(n);
  }
  await tx.objectStore('folders').delete(id);
  await tx.done;
}

/* ── 노트 ── */
export async function listNotes() {
  const all = await (await db()).getAll('notes');
  return all.sort((a, b) => b.updatedAt - a.updatedAt);
}
export async function getNote(id) {
  return (await db()).get('notes', id);
}
export async function saveNote(note) {
  await (await db()).put('notes', note);
  return note;
}
/** 영구 삭제: 노트와 그 노트의 그림을 함께 삭제 */
export async function purgeNote(id) {
  const d = await db();
  const tx = d.transaction(['notes', 'images'], 'readwrite');
  const imgs = await tx.objectStore('images').index('noteId').getAllKeys(id);
  for (const k of imgs) await tx.objectStore('images').delete(k);
  await tx.objectStore('notes').delete(id);
  await tx.done;
}

/* ── 그림 ── */
export async function putImage(image) {
  await (await db()).put('images', image);
  return image;
}
export async function getImage(id) {
  return (await db()).get('images', id);
}
/** 저장 용량 사용량(그림) — 설정 화면 표시용 */
export async function imageUsage() {
  const all = await (await db()).getAll('images');
  return { count: all.length, bytes: all.reduce((s, i) => s + (i.size || 0), 0) };
}
