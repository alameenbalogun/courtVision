import raw from '../shared/thresholds.json';

/**
 * Thresholds shared with the Python pipeline. This file is the single source of
 * truth; cv/analyze.py loads the same JSON. Values are provisional until
 * cv/evaluate.py has been run against a labelled set.
 */
export const THRESHOLDS = raw;

export type Thresholds = typeof raw;

export function minBlobArea(width: number, height: number): number {
  return Math.max(THRESHOLDS.detection.minAreaPx, width * height * THRESHOLDS.detection.minAreaScale);
}

export function maxBlobArea(width: number, height: number): number {
  return Math.max(200, width * height * THRESHOLDS.detection.maxAreaScale);
}
