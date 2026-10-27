// Firebase 연결 — 로그인(Google)과 Firestore(오프라인 저장 포함)
import { initializeApp } from 'firebase/app';
import {
  getAuth, GoogleAuthProvider, signInWithPopup, signInWithRedirect, getRedirectResult,
  onAuthStateChanged, signOut,
} from 'firebase/auth';
import { initializeFirestore, persistentLocalCache, persistentMultipleTabManager } from 'firebase/firestore';
import { firebaseConfig } from './firebase-config.js';

export const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);
auth.languageCode = 'ko';

// 기기 안에 사본을 두어 오프라인에서도 읽고 쓰기, 여러 탭에서 함께 사용
export const fs = initializeFirestore(app, {
  localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() }),
});

const provider = new GoogleAuthProvider();
provider.setCustomParameters({ prompt: 'select_account' });

/** Google 로그인: 팝업 우선, 팝업이 막히면 페이지 이동 방식 */
export async function signIn() {
  try {
    await signInWithPopup(auth, provider);
  } catch (err) {
    const fallback = ['auth/popup-blocked', 'auth/operation-not-supported-in-environment', 'auth/web-storage-unsupported'];
    if (fallback.includes(err.code)) return signInWithRedirect(auth, provider);
    if (err.code === 'auth/popup-closed-by-user' || err.code === 'auth/cancelled-popup-request') return;
    throw err;
  }
}

export const signOutUser = () => signOut(auth);
export const watchAuth = (cb) => onAuthStateChanged(auth, cb);
export const finishRedirect = () => getRedirectResult(auth).catch((e) => console.warn('[YB-EverNote] 로그인 이동 결과', e));
