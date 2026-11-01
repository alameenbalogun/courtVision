import { useMemo } from 'react';
import { courtToFrame } from '@/lib/calibration';
import { COURT_LINES } from '@/lib/court';
import type { Calibration, CourtPoint } from '@/lib/types';

/**
 * Projects calibrated court lines onto the video frame. Lines are sampled so
 * that perspective foreshortening is preserved, and each visible run becomes
 * its own polyline (lines that leave the frame are split, not dropped).
 */
export function CourtOverlay({ calibration }: { calibration: Calibration }) {
  const polylines = useMemo(() => {
    const result: { key: string; points: string; kind: 'boundary' | 'inner' | 'net' }[] = [];

    const inFrame = (point: { x: number; y: number } | null) =>
      point !== null &&
      Number.isFinite(point.x) &&
      Number.isFinite(point.y) &&
      point.x > -0.6 &&
      point.x < 1.6 &&
      point.y > -0.6 &&
      point.y < 1.6;

    for (const line of COURT_LINES) {
      const samples = 14;
      let run: string[] = [];
      let runIndex = 0;

      const flush = () => {
        if (run.length >= 2) {
          result.push({ key: `${line.name}-${runIndex}`, points: run.join(' '), kind: line.kind });
          runIndex++;
        }
        run = [];
      };

      for (let i = 0; i <= samples; i++) {
        const t = i / samples;
        const court: CourtPoint = {
          x: line.from.x + (line.to.x - line.from.x) * t,
          y: line.from.y + (line.to.y - line.from.y) * t,
        };
        const projected = courtToFrame(calibration, court);
        if (inFrame(projected)) {
          run.push(`${((projected as { x: number }).x * 100).toFixed(2)},${((projected as { y: number }).y * 100).toFixed(2)}`);
        } else {
          flush();
        }
      }
      flush();
    }

    return result;
  }, [calibration]);

  const strokeFor = (kind: 'boundary' | 'inner' | 'net') => {
    if (kind === 'net') return { stroke: 'rgba(198, 255, 61, 0.95)', width: 2.5 };
    if (kind === 'boundary') return { stroke: 'rgba(198, 255, 61, 0.7)', width: 2 };
    return { stroke: 'rgba(198, 255, 61, 0.45)', width: 1.4 };
  };

  return (
    <svg className="court-svg" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden>
      {polylines.map((line) => {
        const style = strokeFor(line.kind);
        return (
          <polyline
            key={line.key}
            points={line.points}
            fill="none"
            stroke={style.stroke}
            strokeWidth={style.width}
            strokeDasharray={line.kind === 'inner' ? '5 4' : undefined}
            vectorEffect="non-scaling-stroke"
            strokeLinejoin="round"
            strokeLinecap="round"
          />
        );
      })}
    </svg>
  );
}
