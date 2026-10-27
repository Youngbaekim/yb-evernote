// 벡터 필기 공통 도구 — 좌표 압축, 획 외곽선 계산, 지우개 판정
import { getStroke } from 'perfect-freehand';

/** 필기 블록의 논리 폭. 기기 화면 폭과 관계없이 좌표를 이 기준으로 저장 */
export const UNIT_W = 1000;
export const A4_PAGE_H = Math.round(UNIT_W * Math.SQRT2); // 1414
export const LINE_GAP = 40;

export const PEN_COLORS = ['#16202B', '#1E4FD8', '#D32F2F', '#2E7D32', '#7B1FA2'];
export const HL_COLORS = ['#FFF176', '#C5E1A5', '#F8BBD0', '#B3E5FC'];
export const PEN_SIZES = { thin: 3, normal: 5, thick: 9 };
export const HL_SIZE = 22;

/**
 * 점 배열 압축: [x, y, 필압, 시간] → 차이값 정수 문자열
 * x·y는 0.1 단위, 필압은 0~100, 시간은 ms
 */
export function encodePoints(points) {
  const out = [];
  let px = 0, py = 0, pp = 0, pt = 0;
  for (const [x, y, p, t] of points) {
    const ix = Math.round(x * 10), iy = Math.round(y * 10), ip = Math.round(p * 100), it = Math.round(t);
    out.push(ix - px, iy - py, ip - pp, it - pt);
    px = ix; py = iy; pp = ip; pt = it;
  }
  return out.join(',');
}

export function decodePoints(str) {
  if (!str) return [];
  const v = str.split(',').map(Number);
  const pts = [];
  let x = 0, y = 0, p = 0, t = 0;
  for (let i = 0; i + 3 < v.length; i += 4) {
    x += v[i]; y += v[i + 1]; p += v[i + 2]; t += v[i + 3];
    pts.push([x / 10, y / 10, p / 100, t]);
  }
  return pts;
}

/** 획 외곽선(Path2D) 계산 — 논리 좌표 기준 */
export function strokePath(stroke) {
  const pts = stroke.points || decodePoints(stroke.pts);
  const isHl = stroke.tool === 'highlighter';
  const outline = getStroke(
    pts.map(([x, y, p]) => [x, y, p]),
    {
      size: stroke.size,
      thinning: isHl ? 0 : 0.6,
      smoothing: 0.5,
      streamline: 0.45,
      simulatePressure: !stroke.pressure, // 필압 없는 입력(마우스·손가락)은 속도로 보정
      start: { taper: isHl ? 0 : 6, cap: true },
      end: { taper: isHl ? 0 : 6, cap: true },
      last: true,
    }
  );
  const path = new Path2D();
  if (!outline.length) return path;
  path.moveTo(outline[0][0], outline[0][1]);
  for (let i = 1; i < outline.length; i++) {
    const [x0, y0] = outline[i];
    const [x1, y1] = outline[(i + 1) % outline.length];
    path.quadraticCurveTo(x0, y0, (x0 + x1) / 2, (y0 + y1) / 2);
  }
  path.closePath();
  return path;
}

export function strokeBounds(stroke) {
  const pts = stroke.points || decodePoints(stroke.pts);
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const [x, y] of pts) {
    if (x < minX) minX = x; if (y < minY) minY = y;
    if (x > maxX) maxX = x; if (y > maxY) maxY = y;
  }
  const pad = stroke.size;
  return { minX: minX - pad, minY: minY - pad, maxX: maxX + pad, maxY: maxY + pad };
}

function distToSeg(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay;
  const len = dx * dx + dy * dy;
  let t = len ? ((px - ax) * dx + (py - ay) * dy) / len : 0;
  t = Math.max(0, Math.min(1, t));
  const cx = ax + t * dx, cy = ay + t * dy;
  return Math.hypot(px - cx, py - cy);
}

/** 지우개 판정: (x, y) 반경 r 안에 닿는 획인지 */
export function hitStroke(stroke, x, y, r) {
  const b = stroke.bounds;
  if (x < b.minX - r || x > b.maxX + r || y < b.minY - r || y > b.maxY + r) return false;
  const pts = stroke.points;
  const reach = r + stroke.size / 2;
  if (pts.length === 1) return Math.hypot(x - pts[0][0], y - pts[0][1]) <= reach;
  for (let i = 1; i < pts.length; i++) {
    if (distToSeg(x, y, pts[i - 1][0], pts[i - 1][1], pts[i][0], pts[i][1]) <= reach) return true;
  }
  return false;
}

/** 배경 그리기 (줄노트·모눈·무지) + A4 쪽 구분선 */
export function drawBackground(ctx, kind, heightUnits, paper, ink) {
  ctx.save();
  ctx.lineWidth = 1;
  ctx.strokeStyle = ink.line;
  if (kind === 'lined') {
    ctx.beginPath();
    for (let y = LINE_GAP * 1.5; y < heightUnits; y += LINE_GAP) {
      ctx.moveTo(0, y); ctx.lineTo(UNIT_W, y);
    }
    ctx.stroke();
  } else if (kind === 'grid') {
    ctx.beginPath();
    for (let y = LINE_GAP; y < heightUnits; y += LINE_GAP) { ctx.moveTo(0, y); ctx.lineTo(UNIT_W, y); }
    for (let x = LINE_GAP; x < UNIT_W; x += LINE_GAP) { ctx.moveTo(x, 0); ctx.lineTo(x, heightUnits); }
    ctx.stroke();
  }
  if (paper === 'a4') {
    ctx.strokeStyle = ink.page;
    ctx.setLineDash([10, 8]);
    ctx.lineWidth = 2;
    ctx.beginPath();
    for (let y = A4_PAGE_H; y < heightUnits - 1; y += A4_PAGE_H) { ctx.moveTo(0, y); ctx.lineTo(UNIT_W, y); }
    ctx.stroke();
  }
  ctx.restore();
}
