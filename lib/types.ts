export type MatchFormat = 'singles' | 'doubles';

export type LineCall = 'IN' | 'OUT' | 'UNCERTAIN';

/** 'recording' means the clip is still being written to disk and can be recovered. */
export type MediaStatus = 'recording' | 'ready' | 'error';

export type CloudState = 'none' | 'uploading' | 'uploaded' | 'error';

/** Normalised position inside a video frame (0..1 on both axes). */
export interface ImagePoint {
  x: number;
  y: number;
}

/** Position on the court plane in metres. Origin = near-left doubles corner. */
export interface CourtPoint {
  x: number;
  y: number;
}

export interface CalibrationPoint {
  targetId: string;
  image: ImagePoint;
}

export interface Calibration {
  points: CalibrationPoint[];
  /** Image pixels -> court metres. Row-major 3x3. */
  homography: number[];
  /** Court -> image pixels inverse, kept for drawing the overlay. */
  inverseHomography: number[];
  /** RMS pixel error when projecting court keypoints back onto the frame. */
  reprojectionErrorPx: number;
  frame: { width: number; height: number };
  updatedAt: number;
}

export interface MatchMarker {
  id: string;
  /** Milliseconds into the match recording when the marker was created. */
  atMs: number;
  kind: 'disputed' | 'note';
  note: string;
  createdAt: number;
}

export interface MatchRecord {
  id: string;
  name: string;
  createdAt: number;
  format: MatchFormat;
  calibration: Calibration | null;
  markers: MatchMarker[];
  cloudState: CloudState;
  cloudPath?: string | null;
  cloudError?: string | null;
}

export type MediaKind = 'match' | 'replay';

export interface MediaRecord {
  id: string;
  matchId: string;
  kind: MediaKind;
  label: string;
  createdAt: number;
  /** Offset into the match timeline in milliseconds. */
  startMs: number;
  /** Exact when known; 0 while a recording is still being written. */
  durationMs: number;
  sizeBytes: number;
  mimeType: string;
  status: MediaStatus;
  /** null until a recovered or finished recording has been assembled. */
  blob: Blob | null;
  cloudState: CloudState;
  cloudPath?: string | null;
  cloudError?: string | null;
}

/** One on-disk chunk of an in-progress recording. */
export interface RecordedChunk {
  id: string;
  mediaId: string;
  seq: number;
  /** Match-timeline window covered by this chunk. */
  startMs: number;
  endMs: number;
  size: number;
  blob: Blob;
}

/** A detected ball in a single sampled frame (normalised frame coordinates). */
export interface BallSample {
  timeMs: number;
  x: number;
  y: number;
  confidence: number;
}

export interface BallTrack {
  id: string;
  samples: BallSample[];
}

export interface EvidenceFrame {
  timeMs: number;
  dataUrl: string;
}

export interface BounceEvent {
  id: string;
  timeMs: number;
  trackId: string;
  imagePoint: ImagePoint;
  courtPoint: CourtPoint | null;
  lineCall: LineCall;
  /** Metres from the nearest relevant court line. */
  distanceToLineM: number | null;
  /** 1-sigma uncertainty of the estimated bounce location, in metres. */
  sigmaM: number | null;
  nearestLine: string | null;
  /** 0..1 detector + mapping confidence. */
  confidence: number;
  qualityFlags: string[];
  evidence: EvidenceFrame[];
}

export interface MotionSegment {
  startMs: number;
  endMs: number;
  driftPx: number;
}

export interface CameraMotionReport {
  /** Sub-pixel camera displacement estimate, in low-resolution sample pixels. */
  totalDriftPx: number;
  detected: boolean;
  segments: MotionSegment[];
}

export interface AnalysisResult {
  mediaId: string;
  matchId: string;
  createdAt: number;
  framesAnalyzed: number;
  framesWithBall: number;
  tracks: BallTrack[];
  bounces: BounceEvent[];
  detector: string;
  calibrationErrorPx: number;
  clipDurationMs: number;
  cameraMotion: CameraMotionReport;
  stats: {
    coverage: number;
    candidates: number;
    calls: Record<LineCall, number>;
  };
  warnings: string[];
}

export interface AnalysisProgress {
  phase: 'sampling' | 'motion' | 'tracking' | 'events' | 'evidence' | 'done';
  framesAnalysed: number;
  totalFrames: number;
}
