// 웹 게시 공용 도구 (편집 앱·열람 화면 함께 사용)

/** 공유 링크 → 내려받기 링크
 *  - 회사·학교 OneDrive(SharePoint): download=1을 붙이면 미리보기 없이 바로 내려받기
 *  - 개인 OneDrive(1drv.ms·onedrive.live.com)·기타: 그대로 (OneDrive 화면의 '다운로드' 단추 사용) */
export function downloadUrl(url) {
  try {
    const u = new URL(url);
    if (/(^|\.)sharepoint\.com$/i.test(u.hostname)) {
      u.searchParams.set('download', '1');
      return u.href;
    }
    return u.href;
  } catch {
    return url;
  }
}

export function isWebUrl(s) {
  try { return /^https?:$/.test(new URL(s).protocol); } catch { return false; }
}

/** 링크가 가리키는 곳 이름 (OneDrive 등) */
export function hostLabel(url) {
  try {
    const h = new URL(url).hostname;
    if (/1drv\.ms$|onedrive\.live\.com$|sharepoint\.com$/i.test(h)) return 'OneDrive';
    if (/drive\.google\.com$|docs\.google\.com$/i.test(h)) return 'Google Drive';
    return h.replace(/^www\./, '');
  } catch {
    return '';
  }
}

/** 추측할 수 없는 공유 ID (영문·숫자 16자) */
export function newShareId() {
  const a = new Uint8Array(16);
  crypto.getRandomValues(a);
  return Array.from(a, (b) => 'abcdefghijkmnpqrstuvwxyz23456789'[b % 32]).join('');
}

export const stripTags = (t) => (t || '').replace(/#([\p{L}\p{N}_-]+)/gu, '').replace(/\s{2,}/g, ' ').trim(); // 편집 앱과 같은 규칙
