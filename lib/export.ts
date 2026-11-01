import { pickRecorderMime } from './recorder';

export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

export function downloadJson(data: unknown, filename: string): void {
  downloadBlob(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }), filename);
}

type CapturableVideo = HTMLVideoElement & {
  captureStream?: (fps?: number) => MediaStream;
  mozCaptureStream?: (fps?: number) => MediaStream;
};

type CapturableCanvas = HTMLCanvasElement & {
  captureStream?: (fps?: number) => MediaStream;
};

function seek(video: HTMLVideoElement, timeSec: number): Promise<void> {
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
    window.setTimeout(finish, 800);
  });
}

interface CanvasCapture {
  stream: MediaStream;
  stop: () => void;
}

/**
 * Mirrors the video into a canvas and streams that instead. Needed on browsers
 * where HTMLVideoElement.captureStream is missing (Safari, Firefox).
 */
function startCanvasCapture(video: HTMLVideoElement): CanvasCapture | null {
  const width = video.videoWidth || 1280;
  const height = video.videoHeight || 720;
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d');
  const capture = (canvas as CapturableCanvas).captureStream;
  if (!context || typeof capture !== 'function') return null;

  // Draw once before streaming so the recorder never starts on a blank canvas.
  try {
    context.drawImage(video, 0, 0, width, height);
  } catch {
    return null;
  }

  const stream = capture.call(canvas, 30);
  let handle = window.requestAnimationFrame(function loop() {
    try {
      context.drawImage(video, 0, 0, width, height);
    } catch {
      /* frame not ready */
    }
    handle = window.requestAnimationFrame(loop);
  });

  return {
    stream,
    stop: () => window.cancelAnimationFrame(handle),
  };
}

/**
 * Re-encodes a time range into a downloadable file.
 *
 * Fast path: HTMLVideoElement.captureStream (Chrome). Fallback: canvas
 * re-encode, which works wherever MediaRecorder plus canvas.captureStream
 * exist — Safari and Firefox included. The fallback runs in real time, so
 * exporting five seconds takes about five seconds.
 */
export async function exportSegment(
  video: HTMLVideoElement,
  startSec: number,
  endSec: number,
  filename: string,
  options?: { onProgress?: (fraction: number) => void },
): Promise<void> {
  const span = endSec - startSec;
  if (!(span > 0)) throw new Error('Export range is empty.');

  const mimeType = pickRecorderMime();
  if (!mimeType) throw new Error('No supported export format was found in this browser.');

  const capturable = video as CapturableVideo;
  const elementCapture = capturable.captureStream ?? capturable.mozCaptureStream;

  const wasPaused = video.paused;
  const previousRate = video.playbackRate;
  video.playbackRate = 1;

  await seek(video, startSec);

  let canvasCapture: CanvasCapture | null = null;
  let stream: MediaStream;
  if (elementCapture) {
    stream = elementCapture.call(video, 30);
  } else {
    canvasCapture = startCanvasCapture(video);
    if (!canvasCapture) {
      video.playbackRate = previousRate;
      throw new Error('This browser cannot export a video segment. Download the full clip instead.');
    }
    stream = canvasCapture.stream;
  }

  const recorder = new MediaRecorder(stream, { mimeType, videoBitsPerSecond: 6_000_000 });
  const parts: Blob[] = [];
  recorder.ondataavailable = (event) => {
    if (event.data.size > 0) parts.push(event.data);
  };

  try {
    const finished = new Promise<void>((resolve, reject) => {
      recorder.onstop = () => {
        const blob = new Blob(parts, { type: mimeType });
        if (blob.size === 0) {
          reject(new Error('The export produced no data. Try the full clip download instead.'));
          return;
        }
        downloadBlob(blob, filename);
        resolve();
      };
      recorder.onerror = () => reject(new Error('Export failed while recording the segment.'));
    });

    recorder.start(500);
    await video.play().catch(() => undefined);

    await new Promise<void>((resolve) => {
      const poll = () => {
        const elapsed = video.currentTime - startSec;
        options?.onProgress?.(Math.min(1, Math.max(0, elapsed / span)));
        if (video.currentTime >= endSec - 0.02 || video.ended) {
          video.pause();
          resolve();
          return;
        }
        window.setTimeout(poll, 60);
      };
      poll();
    });

    if (recorder.state !== 'inactive') recorder.stop();
    await finished;
  } finally {
    canvasCapture?.stop();
    stream.getTracks().forEach((track) => track.stop());
    video.playbackRate = previousRate;
    if (!wasPaused) await video.play().catch(() => undefined);
  }
}
