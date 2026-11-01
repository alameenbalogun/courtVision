import type { CourtPoint, MatchFormat } from './types';

/** All distances in metres, ITF standard court. */
export const COURT = {
  length: 23.77,
  doublesWidth: 10.97,
  singlesWidth: 8.23,
  singlesInset: 1.37,
  centreX: 5.485,
  netY: 11.885,
  serviceLineFromNet: 6.4,
} as const;

export const NEAR_SERVICE_Y = COURT.netY - COURT.serviceLineFromNet; // 5.485
export const FAR_SERVICE_Y = COURT.netY + COURT.serviceLineFromNet; // 18.285

export interface CalibrationTarget {
  id: string;
  label: string;
  short: string;
  court: CourtPoint;
  /** 1 = required for a baseline calibration, 2 = improves perspective, 3 = optional. */
  priority: 1 | 2 | 3;
}

export const CALIBRATION_TARGETS: CalibrationTarget[] = [
  {
    id: 'near-left-out',
    label: 'Near-left doubles corner',
    short: 'NL',
    court: { x: 0, y: 0 },
    priority: 1,
  },
  {
    id: 'near-right-out',
    label: 'Near-right doubles corner',
    short: 'NR',
    court: { x: COURT.doublesWidth, y: 0 },
    priority: 1,
  },
  {
    id: 'far-right-out',
    label: 'Far-right doubles corner',
    short: 'FR',
    court: { x: COURT.doublesWidth, y: COURT.length },
    priority: 1,
  },
  {
    id: 'far-left-out',
    label: 'Far-left doubles corner',
    short: 'FL',
    court: { x: 0, y: COURT.length },
    priority: 1,
  },
  {
    id: 'near-left-in',
    label: 'Near-left singles corner',
    short: 'nls',
    court: { x: COURT.singlesInset, y: 0 },
    priority: 2,
  },
  {
    id: 'near-right-in',
    label: 'Near-right singles corner',
    short: 'nrs',
    court: { x: COURT.doublesWidth - COURT.singlesInset, y: 0 },
    priority: 2,
  },
  {
    id: 'far-left-in',
    label: 'Far-left singles corner',
    short: 'fls',
    court: { x: COURT.singlesInset, y: COURT.length },
    priority: 2,
  },
  {
    id: 'far-right-in',
    label: 'Far-right singles corner',
    short: 'frs',
    court: { x: COURT.doublesWidth - COURT.singlesInset, y: COURT.length },
    priority: 2,
  },
  {
    id: 'net-left',
    label: 'Left net post (doubles line)',
    short: 'netL',
    court: { x: 0, y: COURT.netY },
    priority: 3,
  },
  {
    id: 'net-right',
    label: 'Right net post (doubles line)',
    short: 'netR',
    court: { x: COURT.doublesWidth, y: COURT.netY },
    priority: 3,
  },
];

export function getCalibrationTarget(id: string): CalibrationTarget | undefined {
  return CALIBRATION_TARGETS.find((t) => t.id === id);
}

export interface CourtLineSegment {
  name: string;
  from: CourtPoint;
  to: CourtPoint;
  kind: 'boundary' | 'inner' | 'net';
}

export const COURT_LINES: CourtLineSegment[] = [
  { name: 'Near baseline', from: { x: 0, y: 0 }, to: { x: COURT.doublesWidth, y: 0 }, kind: 'boundary' },
  { name: 'Far baseline', from: { x: 0, y: COURT.length }, to: { x: COURT.doublesWidth, y: COURT.length }, kind: 'boundary' },
  { name: 'Left doubles sideline', from: { x: 0, y: 0 }, to: { x: 0, y: COURT.length }, kind: 'boundary' },
  { name: 'Right doubles sideline', from: { x: COURT.doublesWidth, y: 0 }, to: { x: COURT.doublesWidth, y: COURT.length }, kind: 'boundary' },
  { name: 'Left singles sideline', from: { x: COURT.singlesInset, y: 0 }, to: { x: COURT.singlesInset, y: COURT.length }, kind: 'inner' },
  { name: 'Right singles sideline', from: { x: COURT.doublesWidth - COURT.singlesInset, y: 0 }, to: { x: COURT.doublesWidth - COURT.singlesInset, y: COURT.length }, kind: 'inner' },
  { name: 'Near service line', from: { x: COURT.singlesInset, y: NEAR_SERVICE_Y }, to: { x: COURT.doublesWidth - COURT.singlesInset, y: NEAR_SERVICE_Y }, kind: 'inner' },
  { name: 'Far service line', from: { x: COURT.singlesInset, y: FAR_SERVICE_Y }, to: { x: COURT.doublesWidth - COURT.singlesInset, y: FAR_SERVICE_Y }, kind: 'inner' },
  { name: 'Centre service line', from: { x: COURT.centreX, y: NEAR_SERVICE_Y }, to: { x: COURT.centreX, y: FAR_SERVICE_Y }, kind: 'inner' },
  { name: 'Net', from: { x: 0, y: COURT.netY }, to: { x: COURT.doublesWidth, y: COURT.netY }, kind: 'net' },
];

/** In/out boundaries for a format, plus the lines a bounce can be close to. */
export function courtBounds(format: MatchFormat) {
  if (format === 'doubles') {
    return { minX: 0, maxX: COURT.doublesWidth, minY: 0, maxY: COURT.length };
  }
  return { minX: COURT.singlesInset, maxX: COURT.doublesWidth - COURT.singlesInset, minY: 0, maxY: COURT.length };
}

export function isInsideCourt(point: CourtPoint, format: MatchFormat): boolean {
  const b = courtBounds(format);
  return point.x >= b.minX && point.x <= b.maxX && point.y >= b.minY && point.y <= b.maxY;
}

export function courtCenter(format: MatchFormat): CourtPoint {
  const b = courtBounds(format);
  return { x: (b.minX + b.maxX) / 2, y: COURT.netY };
}
