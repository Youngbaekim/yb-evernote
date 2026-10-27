// 그림 자동 압축 — 긴 변 1,600px, WebP(미지원 시 JPEG), 700KB 이하
const MAX_SIDE = 1600;
const MAX_BYTES = 700 * 1024;
const QUALITIES = [0.85, 0.75, 0.65, 0.55, 0.45];

function toBlob(canvas, type, quality) {
  return new Promise((resolve) => canvas.toBlob(resolve, type, quality));
}

async function loadBitmap(file) {
  if ('createImageBitmap' in window) {
    try {
      return await createImageBitmap(file, { imageOrientation: 'from-image' });
    } catch {
      /* 아래 방식으로 재시도 */
    }
  }
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    return img;
  } finally {
    URL.revokeObjectURL(url);
  }
}

/**
 * @param {Blob} file 붙여넣거나 선택한 그림
 * @returns {Promise<{blob: Blob, width: number, height: number, mime: string}>}
 */
export async function compressImage(file) {
  const src = await loadBitmap(file);
  const w0 = src.width;
  const h0 = src.height;
  const scale = Math.min(1, MAX_SIDE / Math.max(w0, h0));
  let w = Math.round(w0 * scale);
  let h = Math.round(h0 * scale);

  const canvas = document.createElement('canvas');
  const draw = () => {
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#ffffff'; // 투명 배경은 흰색으로
    ctx.fillRect(0, 0, w, h);
    ctx.drawImage(src, 0, 0, w, h);
  };
  draw();

  // WebP 인코딩 지원 여부 확인 (일부 Safari는 PNG로 돌려줌)
  let type = 'image/webp';
  const probe = await toBlob(canvas, type, 0.8);
  if (!probe || probe.type !== 'image/webp') type = 'image/jpeg';

  let blob;
  for (let round = 0; round < 3; round++) {
    for (const q of QUALITIES) {
      blob = await toBlob(canvas, type, q);
      if (blob && blob.size <= MAX_BYTES) break;
    }
    if (blob && blob.size <= MAX_BYTES) break;
    // 최저 화질로도 크면 크기를 줄여 다시 시도
    w = Math.round(w * 0.75);
    h = Math.round(h * 0.75);
    draw();
  }
  if (src.close) src.close();
  return { blob, width: w, height: h, mime: blob.type };
}
