import { courtBounds, isInsideCourt } from './court';
import type { CourtPoint, LineCall, MatchFormat } from './types';

/**
 * Decision thresholds are provisional. They must be replaced with values
 * derived from measured validation results before any accuracy claim is made.
 */
export const DECISION_SIGMA_MULTIPLIER = 2;
/** Above this 1-sigma uncertainty the system always abstains. */
export const ABSTAIN_SIGMA_M = 1.0;
/** A projection this far outside the doubles court is not a credible bounce at all. */
export const MAX_PLAUSIBLE_MARGIN_M = 2;

export interface LineCallResult {
  call: LineCall;
  insideCourt: boolean;
  distanceToLineM: number;
  sigmaM: number;
  nearestLine: string;
  reason: string;
}

/**
 * Compares a projected bounce location with the calibrated court lines.
 * Returns UNCERTAIN whenever the uncertainty interval overlaps a line.
 */
export function evaluateBounce(
  point: CourtPoint,
  sigmaM: number,
  format: MatchFormat = 'singles',
): LineCallResult {
  const b = courtBounds(format);
  const inside = isInsideCourt(point, format);

  const edges = [
    { name: 'left sideline', d: Math.abs(point.x - b.minX) },
    { name: 'right sideline', d: Math.abs(point.x - b.maxX) },
    { name: 'near baseline', d: Math.abs(point.y - b.minY) },
    { name: 'far baseline', d: Math.abs(point.y - b.maxY) },
  ].sort((a, c) => a.d - c.d);

  const nearest = edges[0];
  const distanceToLineM = nearest.d;

  if (!Number.isFinite(sigmaM) || sigmaM <= 0) {
    return {
      call: 'UNCERTAIN',
      insideCourt: inside,
      distanceToLineM,
      sigmaM,
      nearestLine: nearest.name,
      reason: 'No usable uncertainty estimate for this location.',
    };
  }

  if (sigmaM > ABSTAIN_SIGMA_M) {
    return {
      call: 'UNCERTAIN',
      insideCourt: inside,
      distanceToLineM,
      sigmaM,
      nearestLine: nearest.name,
      reason: `Location uncertainty (±${sigmaM.toFixed(2)} m) is too large to place the bounce.`,
    };
  }

  const outer = courtBounds('doubles');
  const implausible =
    point.x < outer.minX - MAX_PLAUSIBLE_MARGIN_M ||
    point.x > outer.maxX + MAX_PLAUSIBLE_MARGIN_M ||
    point.y < outer.minY - MAX_PLAUSIBLE_MARGIN_M ||
    point.y > outer.maxY + MAX_PLAUSIBLE_MARGIN_M;
  if (implausible) {
    return {
      call: 'UNCERTAIN',
      insideCourt: inside,
      distanceToLineM,
      sigmaM,
      nearestLine: nearest.name,
      reason: 'Bounce projects far outside the calibrated court; the mapping is not trustworthy.',
    };
  }

  const margin = distanceToLineM - DECISION_SIGMA_MULTIPLIER * sigmaM;
  if (margin <= 0) {
    return {
      call: 'UNCERTAIN',
      insideCourt: inside,
      distanceToLineM,
      sigmaM,
      nearestLine: nearest.name,
      reason: `Bounce is ${distanceToLineM.toFixed(2)} m from the ${nearest.name}, inside the ±${(
        DECISION_SIGMA_MULTIPLIER * sigmaM
      ).toFixed(2)} m uncertainty band.`,
    };
  }

  return {
    call: inside ? 'IN' : 'OUT',
    insideCourt: inside,
    distanceToLineM,
    sigmaM,
    nearestLine: nearest.name,
    reason: `Bounce is ${distanceToLineM.toFixed(2)} m from the ${nearest.name}, outside the uncertainty band.`,
  };
}
