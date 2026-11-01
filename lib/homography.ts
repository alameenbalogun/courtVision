import type { CourtPoint, ImagePoint } from './types';

export type Mat3 = [number, number, number, number, number, number, number, number, number];

export const IDENTITY3: Mat3 = [1, 0, 0, 0, 1, 0, 0, 0, 1];

/**
 * Least-squares homography from 4+ point correspondences.
 * Solves the normal equations of the standard DLT system with h33 fixed to 1.
 */
export function computeHomography(from: ImagePoint[], to: CourtPoint[]): Mat3 | null {
  if (from.length !== to.length || from.length < 4) return null;

  const ata = Array.from({ length: 8 }, () => new Array<number>(8).fill(0));
  const atb = new Array<number>(8).fill(0);

  const accumulate = (row: number[], target: number) => {
    for (let i = 0; i < 8; i++) {
      atb[i] += row[i] * target;
      for (let j = 0; j < 8; j++) ata[i][j] += row[i] * row[j];
    }
  };

  for (let i = 0; i < from.length; i++) {
    const { x, y } = from[i];
    const { x: u, y: v } = to[i];
    accumulate([x, y, 1, 0, 0, 0, -u * x, -u * y], u);
    accumulate([0, 0, 0, x, y, 1, -v * x, -v * y], v);
  }

  // Tiny ridge term keeps degenerate throws from producing a singular matrix.
  for (let i = 0; i < 8; i++) ata[i][i] += 1e-9;

  const h = solveLinearSystem(ata, atb);
  if (!h) return null;
  return [h[0], h[1], h[2], h[3], h[4], h[5], h[6], h[7], 1];
}

/** Gaussian elimination with partial pivoting. Returns null when singular. */
export function solveLinearSystem(a: number[][], b: number[]): number[] | null {
  const n = b.length;
  const m = a.map((row, i) => [...row, b[i]]);

  for (let col = 0; col < n; col++) {
    let pivot = col;
    for (let row = col + 1; row < n; row++) {
      if (Math.abs(m[row][col]) > Math.abs(m[pivot][col])) pivot = row;
    }
    if (Math.abs(m[pivot][col]) < 1e-12) return null;
    [m[col], m[pivot]] = [m[pivot], m[col]];

    const div = m[col][col];
    for (let j = col; j <= n; j++) m[col][j] /= div;

    for (let row = 0; row < n; row++) {
      if (row === col) continue;
      const factor = m[row][col];
      if (factor === 0) continue;
      for (let j = col; j <= n; j++) m[row][j] -= factor * m[col][j];
    }
  }

  return m.map((row) => row[n]);
}

export function applyHomography(h: number[] | Mat3, p: ImagePoint): CourtPoint | null {
  const denom = h[6] * p.x + h[7] * p.y + h[8];
  if (!Number.isFinite(denom) || Math.abs(denom) < 1e-9) return null;
  const x = (h[0] * p.x + h[1] * p.y + h[2]) / denom;
  const y = (h[3] * p.x + h[4] * p.y + h[5]) / denom;
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  return { x, y };
}

export function invertMat3(h: number[] | Mat3): Mat3 | null {
  const [a, b, c, d, e, f, g, i, j] = h;
  const A = e * j - f * i;
  const B = -(d * j - f * g);
  const C = d * i - e * g;
  const det = a * A + b * B + c * C;
  if (!Number.isFinite(det) || Math.abs(det) < 1e-12) return null;
  const inv = [
    A / det,
    -(b * j - c * i) / det,
    (b * f - c * e) / det,
    B / det,
    (a * j - c * g) / det,
    -(a * f - c * d) / det,
    C / det,
    -(a * i - b * g) / det,
    (a * e - b * d) / det,
  ];
  return inv as Mat3;
}

/** Root-mean-square pixel error of the calibration when projected back to the frame. */
export function reprojectionError(
  courtToImage: Mat3 | null,
  pairs: { image: ImagePoint; court: CourtPoint }[],
): number {
  if (!courtToImage || pairs.length === 0) return Number.NaN;
  let sum = 0;
  for (const pair of pairs) {
    const projected = applyHomography(courtToImage, pair.court);
    if (!projected) return Number.NaN;
    sum += (projected.x - pair.image.x) ** 2 + (projected.y - pair.image.y) ** 2;
  }
  return Math.sqrt(sum / pairs.length);
}

/**
 * Propagates pixel-level uncertainty into metres on the court plane.
 * A homography is locally affine, so displacing the image point by `pixels`
 * in each axis approximates the positional uncertainty at that spot.
 */
export function propagateUncertainty(
  imageToCourt: number[] | Mat3,
  image: ImagePoint,
  pixels: number,
): number {
  const base = applyHomography(imageToCourt, image);
  if (!base) return Number.POSITIVE_INFINITY;
  let worst = 0;
  const offsets = [
    { x: pixels, y: 0 },
    { x: -pixels, y: 0 },
    { x: 0, y: pixels },
    { x: 0, y: -pixels },
    { x: pixels * 0.7071, y: pixels * 0.7071 },
    { x: -pixels * 0.7071, y: -pixels * 0.7071 },
  ];
  for (const o of offsets) {
    const projected = applyHomography(imageToCourt, { x: image.x + o.x, y: image.y + o.y });
    if (!projected) return Number.POSITIVE_INFINITY;
    worst = Math.max(worst, Math.hypot(projected.x - base.x, projected.y - base.y));
  }
  return worst;
}
