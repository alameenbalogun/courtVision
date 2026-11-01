import { getCalibrationTarget } from './court';
import { computeHomography, invertMat3, reprojectionError, applyHomography } from './homography';
import type { Calibration, CalibrationPoint, CourtPoint, ImagePoint } from './types';

/** Minimum correspondences needed for a usable homography. */
export const MIN_CALIBRATION_POINTS = 4;

export interface CalibrationBuild {
  calibration: Calibration | null;
  error?: string;
}

/**
 * Builds the image -> court homography from user-marked keypoints.
 * Image coordinates are normalised to the frame when stored, so calibration
 * survives a resize of the preview or review surface.
 */
export function buildCalibration(
  points: CalibrationPoint[],
  frame: { width: number; height: number },
): CalibrationBuild {
  if (frame.width <= 0 || frame.height <= 0) {
    return { calibration: null, error: 'The frame size is unknown. Pause on a visible frame first.' };
  }

  const pairs: { imagePx: ImagePoint; court: CourtPoint }[] = [];
  for (const mark of points) {
    const target = getCalibrationTarget(mark.targetId);
    if (!target) continue;
    pairs.push({
      imagePx: { x: mark.image.x * frame.width, y: mark.image.y * frame.height },
      court: target.court,
    });
  }

  if (pairs.length < MIN_CALIBRATION_POINTS) {
    return {
      calibration: null,
      error: `Mark at least ${MIN_CALIBRATION_POINTS} court points (${pairs.length} marked).`,
    };
  }

  const homography = computeHomography(
    pairs.map((p) => p.imagePx),
    pairs.map((p) => p.court),
  );
  if (!homography) {
    return { calibration: null, error: 'Those points do not define a court plane. Spread them across the court.' };
  }

  const inverse = invertMat3(homography);
  if (!inverse) {
    return { calibration: null, error: 'Calibration matrix could not be inverted. Re-mark the corners.' };
  }

  const errorPx = reprojectionError(
    inverse,
    pairs.map((p) => ({ image: p.imagePx, court: p.court })),
  );

  if (!Number.isFinite(errorPx) || errorPx > 90) {
    return {
      calibration: null,
      error: 'Calibration is inconsistent — check that each point is on the right line and try again.',
    };
  }

  return {
    calibration: {
      points,
      homography,
      inverseHomography: inverse,
      reprojectionErrorPx: errorPx,
      frame,
      updatedAt: Date.now(),
    },
  };
}

/** Projects a court position (metres) into normalised frame coordinates. */
export function courtToFrame(calibration: Calibration, point: CourtPoint): ImagePoint | null {
  const projected = applyHomography(calibration.inverseHomography, point as unknown as ImagePoint);
  if (!projected) return null;
  return { x: projected.x / calibration.frame.width, y: projected.y / calibration.frame.height };
}

/** Projects a normalised frame position onto the court plane (metres). */
export function frameToCourt(calibration: Calibration, point: ImagePoint): CourtPoint | null {
  return applyHomography(calibration.homography, {
    x: point.x * calibration.frame.width,
    y: point.y * calibration.frame.height,
  });
}

export function calibrationQuality(calibration: Calibration | null | undefined): {
  label: string;
  tone: 'good' | 'warn' | 'bad';
  detail: string;
} {
  if (!calibration) {
    return { label: 'Not calibrated', tone: 'bad', detail: 'Mark court keypoints to enable court overlays.' };
  }
  if (calibration.reprojectionErrorPx <= 6) {
    return {
      label: 'Calibration good',
      tone: 'good',
      detail: `Keypoint fit ${calibration.reprojectionErrorPx.toFixed(1)} px RMS.`,
    };
  }
  if (calibration.reprojectionErrorPx <= 15) {
    return {
      label: 'Calibration rough',
      tone: 'warn',
      detail: `Keypoint fit ${calibration.reprojectionErrorPx.toFixed(1)} px RMS — add more points.`,
    };
  }
  return {
    label: 'Calibration poor',
    tone: 'bad',
    detail: `Keypoint fit ${calibration.reprojectionErrorPx.toFixed(1)} px RMS. Re-mark the court.`,
  };
}
