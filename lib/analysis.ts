import { propagateUncertainty, applyHomography } from './homography';
import { evaluateBounce } from './linecall';
import type {
  AnalysisProgress,
  AnalysisResult,
  BallSample,
  BallTrack,
  BounceEvent,
  Calibration,
  EvidenceFrame,
  ImagePoint,
  MatchFormat,
} from './types';

/** Frames are downscaled before detection; coordinates are normalised afterwards. */
const SAMPLE_WIDTH = 480;
const MAX_FRAMES = 400;
const MIN_FRAMES = 24;
/** A ball in flight is off the court plane — single-camera height error, in metres. */
const HEIGHT_UNCERTAINTY_M = 0.35;
const DETECTOR_NAME = 'colour-blob baseline (experimental)';

interface Candidate {
  x: number;
  y: number;
  confidence: number;
  area: number;
}

interface BounceProposal {
  index: number;
  flags: string[];
  prominence: number;
}

export interface AnalyzeOptions {
  mediaId: string;
  matchId: string;
  format: MatchFormat;
  calibration: Calibration | null;
  maxFrames?: number;
  onProgress?: (progress: AnalysisProgress) => void;
}

function detectCandidates(data: Uint8ClampedArray, width: number, height: number): Candidate[] {
  const mask = new Uint8Array(width * height);

  for (let i = 0, p = 0; i < data.length; i += 4, p++) {
    const r = data[i];
    const g = data[i + 1];
    const b = data[i + 2];
    const max = Math.max(r, g, b);
    if (max < 105) continue;
    const min = Math.min(r, g, b);
    const sat = (max - min) / max;
    if (sat < 0.34) continue;
    if (b > 0.9 * max) continue;
    if (r < 70) continue;
    if ((r + g) / 2 - b < 26) continue;
    if (g < 0.7 * r) continue;
    mask[p] = 1;
  }

  const visited = new Uint8Array(width * height);
  const stack: number[] = [];
  const candidates: Candidate[] = [];

  for (let start = 0; start < mask.length; start++) {
    if (!mask[start] || visited[start]) continue;
    visited[start] = 1;
    stack.push(start);
    let area = 0;
    let minX = width;
    let minY = height;
    let maxX = 0;
    let maxY = 0;

    while (stack.length) {
      const p = stack.pop() as number;
      const x = p % width;
      const y = (p - x) / width;
      area++;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;

      if (x > 0) {
        const q = p - 1;
        if (mask[q] && !visited[q]) {
          visited[q] = 1;
          stack.push(q);
        }
      }
      if (x < width - 1) {
        const q = p + 1;
        if (mask[q] && !visited[q]) {
          visited[q] = 1;
          stack.push(q);
        }
      }
      if (y > 0) {
        const q = p - width;
        if (mask[q] && !visited[q]) {
          visited[q] = 1;
          stack.push(q);
        }
      }
      if (y < height - 1) {
        const q = p + width;
        if (mask[q] && !visited[q]) {
          visited[q] = 1;
          stack.push(q);
        }
      }
    }

    if (area < 10 || area > 3200) continue;
    const boxWidth = maxX - minX + 1;
    const boxHeight = maxY - minY + 1;
    if (boxWidth < 2 || boxHeight < 2) continue;
    const aspect = boxWidth / boxHeight;
    if (aspect < 0.3 || aspect > 3.2) continue;
    const fill = area / (boxWidth * boxHeight);
    if (fill < 0.2) continue;

    const confidence = Math.min(
      0.97,
      0.28 + 0.34 * Math.min(1, area / 140) + 0.34 * Math.sqrt(fill),
    );
    candidates.push({
      x: (minX + boxWidth / 2) / width,
      y: (minY + boxHeight / 2) / height,
      confidence,
      area,
    });
  }

  return candidates.sort((a, b) => b.confidence - a.confidence).slice(0, 4);
}

function seekTo(video: HTMLVideoElement, timeSec: number): Promise<void> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      video.removeEventListener('seeked', finish);
      resolve();
    };
    video.addEventListener('seeked', finish);
    try {
      video.currentTime = Math.max(0, timeSec);
    } catch {
      finish();
    }
    window.setTimeout(finish, 500);
  });
}

async function loadVideo(blob: Blob): Promise<HTMLVideoElement> {
  const video = document.createElement('video');
  video.muted = true;
  video.playsInline = true;
  video.preload = 'auto';
  video.src = URL.createObjectURL(blob);

  await new Promise<void>((resolve, reject) => {
    const cleanup = () => {
      video.removeEventListener('loadedmetadata', onLoaded);
      video.removeEventListener('error', onError);
    };
    const onLoaded = () => {
      cleanup();
      resolve();
    };
    const onError = () => {
      cleanup();
      reject(new Error('This clip could not be decoded by the browser.'));
    };
    video.addEventListener('loadedmetadata', onLoaded);
    video.addEventListener('error', onError);
  });

  if (!Number.isFinite(video.duration) || video.duration <= 0) {
    // MediaRecorder blobs often report Infinity until a large seek is forced.
    await new Promise<void>((resolve) => {
      const done = () => {
        video.removeEventListener('durationchange', done);
        resolve();
      };
      video.addEventListener('durationchange', done);
      try {
        video.currentTime = 1e7;
      } catch {
        /* ignore */
      }
      window.setTimeout(done, 800);
    });
    await seekTo(video, 0);
  }

  return video;
}

function linkTracks(frames: { timeMs: number; candidates: Candidate[] }[]): BallTrack[] {
  interface WorkingTrack {
    samples: BallSample[];
    lastIndex: number;
    vx: number;
    vy: number;
  }

  const working: WorkingTrack[] = [];

  for (let i = 0; i < frames.length; i++) {
    const frame = frames[i];
    const assigned = new Set<number>();

    for (const candidate of frame.candidates) {
      let best: WorkingTrack | null = null;
      let bestDistance = Number.POSITIVE_INFINITY;

      for (const track of working) {
        if (i - track.lastIndex > 3) continue;
        const last = track.samples[track.samples.length - 1];
        const gap = i - track.lastIndex + 1;
        const predictedX = last.x + track.vx * gap;
        const predictedY = last.y + track.vy * gap;
        const distance = Math.hypot(candidate.x - predictedX, candidate.y - predictedY);
        const gate = 0.14 * (1 + 0.35 * (gap - 1));
        if (distance < gate && distance < bestDistance && !assigned.has(working.indexOf(track))) {
          best = track;
          bestDistance = distance;
        }
      }

      if (best) {
        const last = best.samples[best.samples.length - 1];
        const gap = i - best.lastIndex + 1;
        best.vx = (candidate.x - last.x) / gap;
        best.vy = (candidate.y - last.y) / gap;
        best.samples.push({ timeMs: frame.timeMs, x: candidate.x, y: candidate.y, confidence: candidate.confidence });
        best.lastIndex = i;
        assigned.add(working.indexOf(best));
      } else {
        working.push({
          samples: [{ timeMs: frame.timeMs, x: candidate.x, y: candidate.y, confidence: candidate.confidence }],
          lastIndex: i,
          vx: 0,
          vy: 0,
        });
      }
    }
  }

  return working
    .filter((track) => track.samples.length >= 3)
    .map((track, index) => ({ id: `track-${index + 1}`, samples: track.samples }))
    .sort((a, b) => b.samples.length - a.samples.length)
    .slice(0, 12);
}

function findBounces(track: BallTrack): BounceProposal[] {
  const samples = track.samples;
  if (samples.length < 3) return [];

  const ys = samples.map((s) => s.y);
  const smooth = ys.map((_, i) => {
    const from = Math.max(0, i - 2);
    const to = Math.min(ys.length - 1, i + 2);
    let sum = 0;
    for (let j = from; j <= to; j++) sum += ys[j];
    return sum / (to - from + 1);
  });

  const proposals: BounceProposal[] = [];
  // Prominence must be measured over a wide window: near the bounce the
  // vertical velocity is close to zero, so a +/-2 sample window sees almost
  // no depth even for a real, fast bounce.
  const window = Math.min(6, Math.max(2, Math.floor(samples.length / 4)));

  for (let i = 2; i < samples.length - 2; i++) {
    const isPeak =
      smooth[i] >= smooth[i - 1] &&
      smooth[i] >= smooth[i + 1] &&
      smooth[i] > smooth[i - 2] &&
      smooth[i] > smooth[i + 2];
    if (!isPeak) continue;
    const left = smooth[Math.max(0, i - window)];
    const right = smooth[Math.min(smooth.length - 1, i + window)];
    const prominence = smooth[i] - Math.max(left, right);
    if (prominence < 0.006) continue;
    proposals.push({ index: i, prominence, flags: [] });
  }

  // A ball that leaves the frame near the bottom may still have bounced.
  const lastIndex = samples.length - 1;
  const last = samples[lastIndex];
  const previous = samples[Math.max(0, lastIndex - 2)];
  if (proposals.length === 0 && last.y > 0.5 && lastIndex >= 3 && last.y - previous.y > 0.005) {
    proposals.push({
      index: lastIndex,
      prominence: Math.max(0.01, last.y - previous.y),
      flags: ['track_ended_near_ground'],
    });
  }

  const picked: BounceProposal[] = [];
  for (const proposal of [...proposals].sort((a, b) => b.prominence - a.prominence)) {
    const tooClose = picked.some(
      (existing) =>
        Math.abs(samples[existing.index].timeMs - samples[proposal.index].timeMs) < 600,
    );
    if (tooClose) continue;
    picked.push(proposal);
    if (picked.length >= 2) break;
  }

  return picked.sort((a, b) => a.index - b.index);
}

async function captureEvidence(
  video: HTMLVideoElement,
  frameCanvas: HTMLCanvasElement,
): Promise<{ timeMs: number; dataUrl: string }[]> {
  const context = frameCanvas.getContext('2d');
  if (!context) return [];
  context.drawImage(video, 0, 0, frameCanvas.width, frameCanvas.height);
  return [{ timeMs: 0, dataUrl: frameCanvas.toDataURL('image/jpeg', 0.62) }];
}

/**
 * Samples a clip, finds tennis-ball coloured blobs, links them into tracks and
 * proposes bounce events. Everything here is a heuristic baseline: it exists so
 * the recording/replay product can be built and reviewed against real footage.
 */
export async function analyzeMedia(blob: Blob, options: AnalyzeOptions): Promise<AnalysisResult> {
  const { mediaId, matchId, format, calibration, onProgress } = options;
  const warnings: string[] = [];
  const video = await loadVideo(blob);

  let durationMs = Number.isFinite(video.duration) && video.duration > 0 ? video.duration * 1000 : 0;
  if (durationMs <= 0) {
    video.src = '';
    throw new Error('Could not read the clip duration. Try saving the clip again.');
  }

  const sampleWidth = Math.min(SAMPLE_WIDTH, video.videoWidth || SAMPLE_WIDTH);
  const sampleHeight = Math.max(
    1,
    Math.round(((video.videoHeight || 270) / (video.videoWidth || 480)) * sampleWidth),
  );

  const canvas = document.createElement('canvas');
  canvas.width = sampleWidth;
  canvas.height = sampleHeight;
  const context = canvas.getContext('2d', { willReadFrequently: true });
  if (!context) throw new Error('Canvas is unavailable, so analysis cannot run.');

  const budget = Math.min(
    options.maxFrames ?? MAX_FRAMES,
    Math.max(MIN_FRAMES, Math.round(durationMs / 40)),
  );
  const stepMs = durationMs / budget;
  if (stepMs > 70) {
    warnings.push(
      `Sparse sampling: one frame every ${Math.round(stepMs)} ms. Bounce timestamps may be late.`,
    );
  }

  const frames: { timeMs: number; candidates: Candidate[] }[] = [];
  let framesWithBall = 0;

  for (let i = 0; i < budget; i++) {
    const timeMs = Math.min(durationMs - 1, i * stepMs);
    if (i > 0) await seekTo(video, timeMs / 1000);
    else await seekTo(video, 0);

    try {
      context.drawImage(video, 0, 0, canvas.width, canvas.height);
      const image = context.getImageData(0, 0, canvas.width, canvas.height);
      const candidates = detectCandidates(image.data, canvas.width, canvas.height);
      if (candidates.length > 0) framesWithBall++;
      frames.push({ timeMs, candidates });
    } catch {
      warnings.push('Some frames could not be read from the clip.');
    }

    if (i % 4 === 0) {
      onProgress?.({ phase: 'sampling', framesAnalysed: i + 1, totalFrames: budget });
      await new Promise((resolve) => window.setTimeout(resolve, 0));
    }
  }

  onProgress?.({ phase: 'tracking', framesAnalysed: budget, totalFrames: budget });
  const tracks = linkTracks(frames);

  onProgress?.({ phase: 'events', framesAnalysed: budget, totalFrames: budget });

  const bounces: BounceEvent[] = [];
  for (const track of tracks) {
    for (const proposal of findBounces(track)) {
      const sample = track.samples[proposal.index];
      const imagePoint: ImagePoint = { x: sample.x, y: sample.y };
      const qualityFlags = ['single_camera_court_plane_projection', ...proposal.flags];

      let courtPoint = null as AnalysisResult['bounces'][number]['courtPoint'];
      let sigmaM: number | null = null;
      let distanceToLineM: number | null = null;
      let nearestLine: string | null = null;
      let lineCall: BounceEvent['lineCall'] = 'UNCERTAIN';
      let baseConfidence = sample.confidence * Math.min(1, 0.55 + proposal.prominence / 0.06);

      if (calibration) {
        const pixelPoint = {
          x: sample.x * calibration.frame.width,
          y: sample.y * calibration.frame.height,
        };
        courtPoint = applyHomography(calibration.homography, pixelPoint);
        if (courtPoint && (Math.abs(courtPoint.x) > 40 || Math.abs(courtPoint.y) > 60)) {
          qualityFlags.push('projected_far_outside_court');
          courtPoint = null;
        }

        if (courtPoint) {
          const calibrationNoise = Math.max(calibration.reprojectionErrorPx, 2.5);
          const detectionNoise = calibrationNoise + (1 - baseConfidence) * 24 + 4;
          const geometric = propagateUncertainty(calibration.homography, pixelPoint, detectionNoise);
          sigmaM = Math.sqrt(Math.min(geometric, 4) ** 2 + HEIGHT_UNCERTAINTY_M ** 2);
          const decision = evaluateBounce(courtPoint, sigmaM, format);
          lineCall = decision.call;
          distanceToLineM = decision.distanceToLineM;
          nearestLine = decision.nearestLine;

          if (sigmaM > 0.5) qualityFlags.push('bounce_location_uncertain');
          if (decision.call === 'UNCERTAIN') qualityFlags.push('line_call_abstained');
          baseConfidence *= 0.85;
        } else {
          qualityFlags.push('no_court_projection');
        }
      } else {
        qualityFlags.push('no_calibration');
      }

      if (baseConfidence < 0.55) qualityFlags.push('possible_motion_blur');
      if (track.samples.length < 5) qualityFlags.push('short_track');
      if (sample.x < 0.04 || sample.x > 0.96 || sample.y < 0.04 || sample.y > 0.96) {
        qualityFlags.push('near_frame_edge');
      }

      bounces.push({
        id: `${track.id}-b${bounces.length + 1}`,
        timeMs: Math.round(sample.timeMs),
        trackId: track.id,
        imagePoint,
        courtPoint,
        lineCall,
        distanceToLineM,
        sigmaM,
        nearestLine,
        confidence: Math.max(0, Math.min(1, baseConfidence)),
        qualityFlags: Array.from(new Set(qualityFlags)),
        evidence: [],
      });
    }
  }

  if (bounces.length > 0) {
    onProgress?.({ phase: 'evidence', framesAnalysed: budget, totalFrames: budget });
    const thumb = document.createElement('canvas');
    thumb.width = 360;
    thumb.height = Math.max(1, Math.round((video.videoHeight / video.videoWidth) * 360) || 202);

    for (const bounce of bounces.slice(0, 4)) {
      const offsets = [-320, -140, 0, 180];
      for (const offset of offsets) {
        const timeMs = Math.max(0, Math.min(durationMs - 1, bounce.timeMs + offset));
        await seekTo(video, timeMs / 1000);
        const captured = await captureEvidence(video, thumb);
        for (const frame of captured) {
          bounce.evidence.push({ timeMs: Math.round(timeMs), dataUrl: frame.dataUrl });
        }
      }
    }
  }

  if (tracks.length === 0) {
    warnings.push(
      'No ball-sized detections were found. The baseline detector expects a visible yellow-green ball and decent lighting.',
    );
  }
  if (framesWithBall / Math.max(1, budget) < 0.08 && tracks.length > 0) {
    warnings.push('Ball coverage is very low; treat timestamps and locations as rough.');
  }

  video.src = '';
  onProgress?.({ phase: 'done', framesAnalysed: budget, totalFrames: budget });

  return {
    mediaId,
    matchId,
    createdAt: Date.now(),
    framesAnalyzed: budget,
    framesWithBall,
    tracks,
    bounces,
    detector: DETECTOR_NAME,
    calibrationErrorPx: calibration?.reprojectionErrorPx ?? Number.NaN,
    clipDurationMs: durationMs,
    warnings: Array.from(new Set(warnings)),
  };
}
