// PDF 가져오기 (v0.9.2) — 쪽마다 고화질 그림 + 글자(검색용)
// pdf.js는 PDF를 가져올 때만 불러옴 (앱 첫 화면을 무겁게 하지 않도록)
// 한글 등 글꼴을 PDF에 넣지 않은 문서를 위해 글자 대응표(cMap)는 CDN에서 받음
const PDFJS_VER = '4.10.38';
const CDN = `https://cdn.jsdelivr.net/npm/pdfjs-dist@${PDFJS_VER}`;
export const PDF_SIDE = 2400; // 쪽 그림의 긴 변(px)
const TEXT_MAX = 2500; // 쪽마다 검색용 글자 상한 (노트 문서 1MB 제한 고려)

let lib = null;
async function load() {
  if (lib) return lib;
  const [pdfjs, worker] = await Promise.all([
    import('pdfjs-dist/legacy/build/pdf.mjs'),
    import('pdfjs-dist/legacy/build/pdf.worker.min.mjs?url'),
  ]);
  pdfjs.GlobalWorkerOptions.workerSrc = worker.default;
  lib = pdfjs;
  return lib;
}

export const isPdf = (f) => !!f && (f.type === 'application/pdf' || /\.pdf$/i.test(f.name || ''));

/** PDF 열기 → { numPages, page(i) → { canvas, text }, close() } */
export async function openPdf(file) {
  const pdfjs = await load();
  const data = new Uint8Array(await file.arrayBuffer());
  const doc = await pdfjs.getDocument({
    data,
    cMapUrl: `${CDN}/cmaps/`,
    cMapPacked: true,
    standardFontDataUrl: `${CDN}/standard_fonts/`,
    isEvalSupported: false,
  }).promise;
  return {
    numPages: doc.numPages,
    async page(i) {
      const pg = await doc.getPage(i);
      const v1 = pg.getViewport({ scale: 1 });
      const scale = PDF_SIDE / Math.max(v1.width, v1.height);
      const vp = pg.getViewport({ scale });
      const canvas = document.createElement('canvas');
      canvas.width = Math.round(vp.width);
      canvas.height = Math.round(vp.height);
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      await pg.render({ canvasContext: ctx, viewport: vp }).promise;
      let text = '';
      try {
        const tc = await pg.getTextContent();
        text = tc.items.map((it) => (it.str || '') + (it.hasEOL ? '\n' : '')).join('').replace(/[ \t]+/g, ' ').replace(/\n{2,}/g, '\n').trim().slice(0, TEXT_MAX);
      } catch { /* 글자 없는 PDF(스캔본) */ }
      pg.cleanup();
      return { canvas, text };
    },
    close() { doc.destroy(); },
  };
}
