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

/** 주소 코드: 영문 소문자·숫자·하이픈, 3~20자 (무작위 ID 16자도 같은 규칙) */
export const CODE_RE = /^[a-z0-9](?:[a-z0-9-]{1,30}[a-z0-9])$/;
export const normCode = (s) => String(s || '').trim().toLowerCase().replace(/\s+/g, '-');

/* ───────── HTML 노트 (v0.9.0) ───────── */
/** 가져온 HTML 정리: 스크립트·외부 실행 요소·이벤트 속성 제거 (서식·표·그림은 그대로)
 *  화면에서도 스크립트가 실행되지 않는 분리 화면에 띄우지만, 웹 게시까지 고려해 한 번 더 걸러 둠 */
export function sanitizeHtml(html) {
  const doc = new DOMParser().parseFromString(String(html || ''), 'text/html');
  doc.querySelectorAll('script, noscript, iframe, frame, frameset, object, embed, applet, base, portal, meta[http-equiv]').forEach((e) => e.remove());
  doc.querySelectorAll('link').forEach((e) => { if (!/stylesheet|icon/i.test(e.getAttribute('rel') || '')) e.remove(); });
  doc.querySelectorAll('*').forEach((el) => {
    for (const a of [...el.attributes]) {
      const n = a.name.toLowerCase();
      const v = a.value.trim().toLowerCase().replace(/\s+/g, '');
      if (n.startsWith('on')) el.removeAttribute(a.name);
      else if (['href', 'src', 'action', 'formaction', 'xlink:href', 'srcdoc'].includes(n) && (v.startsWith('javascript:') || v.startsWith('vbscript:') || (n === 'srcdoc'))) el.removeAttribute(a.name);
      else if (n === 'contenteditable' || n === 'autofocus') el.removeAttribute(a.name);
    }
  });
  return '<!DOCTYPE html>\n' + doc.documentElement.outerHTML;
}

/** HTML에서 글자만 (검색·미리보기용) */
export function htmlText(html) {
  if (!html) return '';
  const doc = new DOMParser().parseFromString(html, 'text/html');
  doc.querySelectorAll('style, script, noscript, template').forEach((e) => e.remove());
  doc.querySelectorAll('br').forEach((e) => e.replaceWith('\n'));
  doc.querySelectorAll('p, div, li, tr, h1, h2, h3, h4, h5, h6, section, article, header, footer, blockquote, pre, table, caption').forEach((e) => e.append('\n'));
  doc.querySelectorAll('td, th').forEach((e) => e.append(' '));
  return (doc.body?.textContent || '').replace(/[ \t ]+/g, ' ').replace(/ *\n[\n ]*/g, '\n').trim();
}

/** HTML 문서 제목 */
export function htmlTitle(html) {
  try { return new DOMParser().parseFromString(html, 'text/html').title.trim(); } catch { return ''; }
}

/** 저장 용량 (UTF-8 바이트) */
export const byteSize = (s) => new Blob([s || '']).size;
