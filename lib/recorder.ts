import type { RecordedChunk } from './types';

export function pickRecorderMime(): string | undefined {
  if (typeof MediaRecorder === 'undefined') return undefined;
  const candidates = [
    'video/webm;codecs=vp9',
    'video/webm;codecs=vp8',
    'video/webm',
    'video/mp4;codecs=avc1.42E01E',
    'video/mp4',
  ];
  return candidates.find((type) => MediaRecorder.isTypeSupported(type));
}

export function supportedRecorderMimeTypes(): { type: string; supported: boolean }[] {
  if (typeof MediaRecorder === 'undefined') return [];
  const candidates = [
    'video/webm;codecs=vp9',
    'video/webm;codecs=vp8',
    'video/webm',
    'video/mp4;codecs=avc1.42E01E',
    'video/mp4',
  ];
  return candidates.map((type) => ({ type, supported: MediaRecorder.isTypeSupported(type) }));
}

export interface DeviceSupport {
  getUserMedia: boolean;
  mediaRecorder: boolean;
  elementCaptureStream: boolean;
  canvasCaptureStream: boolean;
  wakeLock: boolean;
  codecs: { type: string; supported: boolean }[];
  preferredType?: string;
  secureContext: boolean;
  reason?: string;
}

/** Diagnostic snapshot so device-specific failures are visible instead of silent. */
export function describeDeviceSupport(): DeviceSupport {
  const secureContext = typeof window !== 'undefined' && window.isSecureContext;
  const getUserMedia = typeof navigator !== 'undefined' && !!navigator.mediaDevices?.getUserMedia;
  const mediaRecorder = typeof MediaRecorder !== 'undefined';
  const codecs = supportedRecorderMimeTypes();
  const videoEl = typeof HTMLVideoElement !== 'undefined' ? HTMLVideoElement.prototype : undefined;
  const canvasEl = typeof HTMLCanvasElement !== 'undefined' ? HTMLCanvasElement.prototype : undefined;

  const support: DeviceSupport = {
    secureContext,
    getUserMedia,
    mediaRecorder,
    elementCaptureStream: typeof videoEl?.captureStream === 'function',
    canvasCaptureStream: typeof canvasEl?.captureStream === 'function',
    wakeLock: typeof navigator !== 'undefined' && 'wakeLock' in navigator,
    codecs,
    preferredType: pickRecorderMime(),
  };

  if (!secureContext) support.reason = 'Camera access requires HTTPS (or localhost).';
  else if (!getUserMedia) support.reason = 'This browser does not expose getUserMedia.';
  else if (!mediaRecorder) support.reason = 'This browser does not support MediaRecorder.';
  else if (!support.preferredType) support.reason = 'No supported recording format was found.';

  return support;
}

export function describeCameraSupport(): { supported: boolean; reason?: string } {
  const support = describeDeviceSupport();
  return { supported: !support.reason, reason: support.reason };
}

export async function getCameraStream(options: {
  facingMode?: 'environment' | 'user';
  width?: number;
  height?: number;
  frameRate?: number;
}): Promise<MediaStream> {
  const { facingMode = 'environment', width = 1920, height = 1080, frameRate = 30 } = options;
  if (typeof navigator === 'undefined' || !navigator.mediaDevices?.getUserMedia) {
    throw new Error(
      'Camera access is unavailable. Use a modern browser over HTTPS (or localhost) and allow camera permission.',
    );
  }
  try {
    return await navigator.mediaDevices.getUserMedia({
      video: {
        facingMode: { ideal: facingMode },
        width: { ideal: width },
        height: { ideal: height },
        frameRate: { ideal: frameRate },
        // Prefer a stable exposure for the tracker.
        exposureCompensation: { ideal: 0 },
      } as MediaTrackConstraints,
      audio: false,
    });
  } catch (error) {
    const err = error as DOMException;
    if (err?.name === 'NotAllowedError') {
      throw new Error('Camera permission was denied. Allow camera access for this site and try again.');
    }
    if (err?.name === 'NotFoundError') {
      throw new Error('No camera was found on this device.');
    }
    if (err?.name === 'NotReadableError') {
      throw new Error('The camera is in use by another app. Close it and try again.');
    }
    if (err?.name === 'OverconstrainedError') {
      return getCameraStream({ ...options, width: 1280, height: 720 });
    }
    throw new Error(err?.message || 'Could not start the camera.');
  }
}

/** Keeps the screen awake while recording. Returns a release function. */
export async function acquireWakeLock(): Promise<() => void> {
  const nav = navigator as Navigator & {
    wakeLock?: { request: (type: 'screen') => Promise<{ release: () => Promise<void>; released: boolean }> };
  };
  if (!nav.wakeLock) return () => undefined;
  try {
    const lock = await nav.wakeLock.request('screen');
    return () => {
      if (!lock.released) void lock.release().catch(() => undefined);
    };
  } catch {
    return () => undefined;
  }
}

export interface ReplayClip {
  blob: Blob;
  mimeType: string;
  /** Match-timeline offset where the replay window starts. */
  startMs: number;
  /** Measured from chunk arrival windows, not from the timeslice length. */
  durationMs: number;
}

export interface SessionRecorderOptions {
  mediaId: string;
  /** Called once per chunk; the chunk is written to durable storage by the caller. */
  onChunk: (chunk: RecordedChunk) => void | Promise<void>;
  onError?: (error: Error) => void;
  bufferSeconds?: number;
  timesliceMs?: number;
  mimeType?: string;
}

interface PauseSpan {
  start: number;
  end: number;
}

interface RingChunk {
  seq: number;
  blob: Blob;
  startMs: number;
  endMs: number;
}

/**
 * Records a match while writing every chunk to durable storage as it arrives.
 * Memory only ever holds the replay window plus one chunk in flight, so long
 * matches no longer depend on the tab staying alive with everything buffered.
 */
export class SessionRecorder {
  private recorder: MediaRecorder | null = null;
  private stream: MediaStream | null = null;
  private mimeType = '';
  private timesliceMs = 1000;
  private bufferSeconds = 15;
  private mediaId = '';
  private sink: SessionRecorderOptions['onChunk'] | null = null;
  private onError: ((error: Error) => void) | null = null;
  private ring: RingChunk[] = [];
  private seq = 0;
  private startWall = 0;
  private pauses: PauseSpan[] = [];
  private activePauseStart = 0;
  private nextChunkStartMs = 0;
  private bytesWritten = 0;
  private writeChain: Promise<void> = Promise.resolve();
  private writeError: Error | null = null;

  get active(): boolean {
    return this.recorder?.state === 'recording' || this.recorder?.state === 'paused';
  }

  get paused(): boolean {
    return this.recorder?.state === 'paused';
  }

  get bufferedMs(): number {
    if (this.ring.length < 2) return 0;
    return this.ring[this.ring.length - 1].endMs - this.ring[0].startMs;
  }

  get totalBytes(): number {
    return this.bytesWritten;
  }

  get mime(): string {
    return this.mimeType;
  }

  get failedWrite(): Error | null {
    return this.writeError;
  }

  /** Wall-clock time -> match timeline, skipping paused spans. */
  private matchMs(wall: number): number {
    const pausedBefore = this.pauses.reduce((sum, span) => {
      const end = span.end || this.activePauseStart || wall;
      return sum + Math.max(0, end - span.start);
    }, 0);
    return Math.max(0, wall - this.startWall - pausedBefore);
  }

  start(stream: MediaStream, options: SessionRecorderOptions): void {
    if (this.recorder) throw new Error('A recording session is already running.');
    const mimeType = options.mimeType ?? pickRecorderMime();
    if (!mimeType) throw new Error('No supported recording format was found in this browser.');

    this.stream = stream;
    this.mimeType = mimeType;
    this.mediaId = options.mediaId;
    this.sink = options.onChunk;
    this.onError = options.onError ?? null;
    this.timesliceMs = options.timesliceMs ?? 1000;
    this.bufferSeconds = options.bufferSeconds ?? 15;
    this.ring = [];
    this.seq = 0;
    this.bytesWritten = 0;
    this.writeError = null;
    this.pauses = [];
    this.activePauseStart = 0;
    this.nextChunkStartMs = 0;
    this.startWall = Date.now();
    this.writeChain = Promise.resolve();

    const recorder = new MediaRecorder(stream, {
      mimeType,
      videoBitsPerSecond: 6_000_000,
    });
    this.recorder = recorder;

    recorder.ondataavailable = (event) => {
      if (!event.data || event.data.size === 0) return;
      const wallEnd = Date.now();
      const endMs = this.matchMs(wallEnd);
      const startMs = Math.min(this.nextChunkStartMs, endMs);
      this.nextChunkStartMs = endMs;

      const seq = this.seq++;
      const blob = event.data;
      this.bytesWritten += blob.size;

      // Memory holds only the rolling replay window; the full recording goes to
      // durable storage immediately and is reassembled on stop.
      this.ring.push({ seq, blob, startMs, endMs });
      this.trimRing(endMs);

      const chunk: RecordedChunk = {
        id: `${this.mediaId}:${String(seq).padStart(6, '0')}`,
        mediaId: this.mediaId,
        seq,
        startMs,
        endMs,
        size: blob.size,
        blob,
      };
      if (this.sink) {
        this.writeChain = this.writeChain
          .then(() => this.sink?.(chunk))
          .catch((error: unknown) => {
            this.writeError = (error as Error) ?? new Error('Could not write a recording chunk to disk.');
            this.onError?.(this.writeError);
          });
      }
    };

    recorder.start(this.timesliceMs);
  }

  private trimRing(nowMs: number): void {
    const cutoff = nowMs - this.bufferSeconds * 1000;
    while (this.ring.length > 1 && this.ring[0].endMs < cutoff) {
      this.ring.shift();
    }
  }

  elapsedMs(): number {
    if (!this.startWall) return 0;
    return this.matchMs(this.paused ? this.activePauseStart : Date.now());
  }

  pause(): void {
    if (this.recorder?.state === 'recording') {
      this.recorder.pause();
      this.activePauseStart = Date.now();
      this.pauses.push({ start: this.activePauseStart, end: 0 });
    }
  }

  resume(): void {
    if (this.recorder?.state === 'paused') {
      const now = Date.now();
      const last = this.pauses[this.pauses.length - 1];
      if (last && !last.end) last.end = now;
      this.activePauseStart = 0;
      this.recorder.resume();
    }
  }

  /** Builds a clip from the most recent window, with measured start and duration. */
  saveReplay(windowMs?: number): ReplayClip | null {
    const window = windowMs ?? this.bufferSeconds * 1000;
    const now = this.elapsedMs();
    this.trimRing(now);
    const chunks = this.ring.filter((chunk) => chunk.endMs >= now - window);
    if (chunks.length === 0) return null;

    const blob = new Blob(
      chunks.map((chunk) => chunk.blob),
      { type: this.mimeType },
    );
    const first = chunks[0];
    const last = chunks[chunks.length - 1];

    return {
      blob,
      mimeType: this.mimeType,
      startMs: first.startMs,
      durationMs: Math.max(last.endMs - first.startMs, this.timesliceMs * chunks.length * 0.5),
    };
  }

  /**
   * Stops recording and returns the measured duration. Chunks are already on
   * disk; the caller assembles them with assembleRecording().
   */
  async stop(): Promise<{ durationMs: number; sizeBytes: number; mimeType: string }> {
    const recorder = this.recorder;
    if (!recorder) throw new Error('No recording is running.');

    const durationMs = this.elapsedMs();
    await new Promise<void>((resolve, reject) => {
      recorder.onstop = () => resolve();
      recorder.onerror = () => reject(new Error('Recording failed unexpectedly.'));
      if (recorder.state === 'paused') {
        const now = Date.now();
        const last = this.pauses[this.pauses.length - 1];
        if (last && !last.end) last.end = now;
        this.activePauseStart = 0;
        recorder.resume();
      }
      if (recorder.state !== 'inactive') recorder.stop();
      else resolve();
    });

    await this.writeChain;

    this.stream?.getTracks().forEach((track) => track.stop());
    this.stream = null;
    this.recorder = null;
    this.ring = [];

    return { durationMs, sizeBytes: this.bytesWritten, mimeType: this.mimeType };
  }

  /** Stops tracks and drops the in-memory window without touching stored chunks. */
  discard(): void {
    this.stream?.getTracks().forEach((track) => track.stop());
    if (this.recorder && this.recorder.state !== 'inactive') {
      this.recorder.onstop = null;
      try {
        this.recorder.stop();
      } catch {
        /* already stopped */
      }
    }
    this.stream = null;
    this.recorder = null;
    this.ring = [];
  }
}
