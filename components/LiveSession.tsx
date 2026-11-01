'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useRef, useState } from 'react';
import { saveMatch, saveMedia, storageInfo, type StorageInfo } from '@/lib/db';
import { downloadBlob } from '@/lib/export';
import { describeCameraSupport, getCameraStream, SessionRecorder } from '@/lib/recorder';
import { formatBytes, formatDuration, formatTimecode, uid } from '@/lib/utils';
import type { MatchFormat, MatchMarker, MatchRecord, MediaRecord } from '@/lib/types';

type Status = 'idle' | 'starting' | 'ready' | 'live' | 'paused' | 'ending';

const BUFFER_OPTIONS = [10, 15, 20];

function defaultMatchName(): string {
  return `Match · ${new Date().toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })}`;
}

export function LiveSession() {
  const router = useRouter();
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const recorderRef = useRef<SessionRecorder | null>(null);
  const matchRef = useRef<MatchRecord | null>(null);
  const streamRef = useRef<MediaStream | null>(null);

  // Resolved after mount: camera support and the default name depend on the
  // browser and clock, so they must not diverge between server and client.
  const [support, setSupport] = useState<{ supported: boolean; reason?: string } | null>(null);
  const [defaultName, setDefaultName] = useState('');

  const [stream, setStream] = useState<MediaStream | null>(null);
  const [status, setStatus] = useState<Status>('idle');
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [matchName, setMatchName] = useState('');
  const [format, setFormat] = useState<MatchFormat>('singles');
  const [bufferSeconds, setBufferSeconds] = useState(15);
  const [lowPower, setLowPower] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [bytes, setBytes] = useState(0);
  const [savedClips, setSavedClips] = useState<MediaRecord[]>([]);
  const [markers, setMarkers] = useState<MatchMarker[]>([]);
  const [note, setNote] = useState('');
  const [storage, setStorage] = useState<StorageInfo | null>(null);
  const [resolution, setResolution] = useState<string | null>(null);

  const recording = status === 'live' || status === 'paused';
  const cameraOn = stream !== null;

  const refreshStorage = useCallback(async () => {
    setStorage(await storageInfo());
  }, []);

  useEffect(() => {
    refreshStorage();
    setSupport(describeCameraSupport());
    setDefaultName(defaultMatchName());
  }, [refreshStorage]);

  useEffect(() => {
    const video = videoRef.current;
    if (video && stream) {
      video.srcObject = stream;
      void video.play().catch(() => undefined);
    }
  }, [stream]);

  useEffect(() => {
    if (!recording) return;
    const timer = window.setInterval(() => {
      const recorder = recorderRef.current;
      if (recorder) {
        setElapsed(recorder.elapsedMs());
        setBytes(recorder.totalBytes);
      }
    }, 250);
    return () => window.clearInterval(timer);
  }, [recording]);

  useEffect(() => {
    return () => {
      recorderRef.current?.discard();
      streamRef.current?.getTracks().forEach((track) => track.stop());
    };
  }, []);

  const ensureMatch = useCallback(async (): Promise<MatchRecord> => {
    if (matchRef.current) return matchRef.current;
    const match: MatchRecord = {
      id: uid('match_'),
      name: matchName.trim() || defaultName || 'Untitled match',
      createdAt: Date.now(),
      format,
      calibration: null,
      markers: [],
    };
    await saveMatch(match);
    matchRef.current = match;
    setMatchName(match.name);
    setMarkers(match.markers);
    return match;
  }, [defaultName, format, matchName]);

  const enableCamera = async () => {
    setError(null);
    setStatus('starting');
    try {
      const media = await getCameraStream({
        facingMode: 'environment',
        width: lowPower ? 1280 : 1920,
        height: lowPower ? 720 : 1080,
      });
      streamRef.current = media;
      setStream(media);
      const track = media.getVideoTracks()[0];
      const settings = track?.getSettings();
      setResolution(settings?.width && settings?.height ? `${settings.width}×${settings.height}` : null);
      setStatus('ready');
    } catch (err) {
      setError((err as Error).message);
      setStatus('idle');
    }
  };

  const startMatch = async () => {
    setError(null);
    setMessage(null);
    try {
      const match = await ensureMatch();
      let media = streamRef.current;
      if (!media) {
        media = await getCameraStream({
          facingMode: 'environment',
          width: lowPower ? 1280 : 1920,
          height: lowPower ? 720 : 1080,
        });
        streamRef.current = media;
        setStream(media);
      }
      const recorder = new SessionRecorder();
      recorder.start(media, { bufferSeconds });
      recorderRef.current = recorder;
      setStatus('live');
      setElapsed(0);
      setBytes(0);
      setMessage(`Recording locally for “${match.name}”. Replay buffer: ${bufferSeconds}s.`);
    } catch (err) {
      setError((err as Error).message);
      setStatus(streamRef.current ? 'ready' : 'idle');
    }
  };

  const pauseMatch = () => {
    recorderRef.current?.pause();
    setStatus('paused');
  };

  const resumeMatch = () => {
    recorderRef.current?.resume();
    setStatus('live');
  };

  const saveReplay = async () => {
    const recorder = recorderRef.current;
    if (!recorder) return;
    setError(null);
    try {
      const clip = recorder.saveReplay(bufferSeconds);
      if (!clip || clip.blob.size === 0) {
        setMessage('Nothing buffered yet — record for a second or two, then save.');
        return;
      }
      const match = await ensureMatch();
      const media: MediaRecord = {
        id: uid('clip_'),
        matchId: match.id,
        kind: 'replay',
        label: `Replay at ${formatTimecode(recorder.elapsedMs(), false)}`,
        createdAt: Date.now(),
        durationMs: clip.durationMs,
        sizeBytes: clip.blob.size,
        mimeType: clip.mimeType,
        blob: clip.blob,
      };
      await saveMedia(media);
      setSavedClips((prev) => [media, ...prev]);
      setMessage(`Saved the last ~${Math.round(clip.durationMs / 1000)}s as a replay clip.`);
      await refreshStorage();
    } catch (err) {
      setError(`Could not save the replay: ${(err as Error).message}`);
    }
  };

  const addMarker = async (kind: MatchMarker['kind'], text: string) => {
    setError(null);
    try {
      const match = await ensureMatch();
      const marker: MatchMarker = {
        id: uid('mk_'),
        atMs: recorderRef.current?.elapsedMs() ?? 0,
        kind,
        note: text,
        createdAt: Date.now(),
      };
      const updated = { ...match, markers: [...match.markers, marker] };
      matchRef.current = updated;
      await saveMatch(updated);
      setMarkers(updated.markers);
      setNote('');
      setMessage(
        kind === 'disputed'
          ? `Disputed point marked at ${formatTimecode(marker.atMs, false)}.`
          : 'Note saved to this session.',
      );
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const endMatch = async () => {
    const recorder = recorderRef.current;
    const match = matchRef.current;
    setStatus('ending');
    setError(null);
    try {
      if (recorder) {
        const { blob, mimeType, durationMs } = await recorder.stop();
        recorderRef.current = null;
        if (match && blob.size > 0) {
          const media: MediaRecord = {
            id: uid('rec_'),
            matchId: match.id,
            kind: 'match',
            label: `${match.name} · recording`,
            createdAt: Date.now(),
            durationMs,
            sizeBytes: blob.size,
            mimeType,
            blob,
          };
          await saveMedia(media);
        }
      }
      streamRef.current?.getTracks().forEach((track) => track.stop());
      streamRef.current = null;
      setStream(null);
      await refreshStorage();
      if (match) router.push(`/match/${match.id}`);
      else setStatus('idle');
    } catch (err) {
      setError(`Could not finish the recording: ${(err as Error).message}`);
      setStatus('idle');
    }
  };

  const setupLocked = recording || status === 'ending';

  return (
    <div className="session">
      <div className="control-stack">
        <div className="preview">
          <video ref={videoRef} className="preview-video" autoPlay muted playsInline />
          {cameraOn && (
            <div className="framing-guide">
              <span>Frame the whole court</span>
            </div>
          )}
          <div className="hud">
            {recording && (
              <span className="hud-item">
                <span className={`rec-dot ${status === 'paused' ? 'rec-dot--paused' : ''}`} />
                {status === 'paused' ? 'Paused' : 'Recording'}
                <span className="hud-timer">{formatDuration(elapsed)}</span>
              </span>
            )}
            {!recording && status === 'ready' && <span className="hud-item">Camera ready</span>}
            {resolution && <span className="hud-item">{resolution}</span>}
            {lowPower && <span className="hud-item">Low power</span>}
          </div>
          {!cameraOn && (
            <div className="preview-placeholder">
              <strong style={{ color: 'var(--text)' }}>
                {support?.supported === false ? 'Camera unavailable' : 'Camera preview'}
              </strong>
              <span>
                {support === null
                  ? 'Checking camera support…'
                  : support.supported
                    ? 'Tap Enable camera to grant permission. Nothing is recorded until you start a match.'
                    : support.reason}
              </span>
            </div>
          )}
        </div>

        {error && (
          <div className="notice notice--danger">
            <strong>Something needs attention.</strong>
            <p>{error}</p>
          </div>
        )}
        {message && !error && <div className="notice">{message}</div>}

        <div className="card">
          <div className="btn-row">
            {!recording && status !== 'ending' && (
              <button
                type="button"
                className="btn btn--primary"
                onClick={startMatch}
                disabled={!support?.supported || status === 'starting'}
              >
                {status === 'starting' ? 'Starting camera…' : 'Start match'}
              </button>
            )}
            {status === 'live' && (
              <button type="button" className="btn" onClick={pauseMatch}>
                Pause
              </button>
            )}
            {status === 'paused' && (
              <button type="button" className="btn btn--primary" onClick={resumeMatch}>
                Resume
              </button>
            )}
            {recording && (
              <button type="button" className="btn btn--danger" onClick={endMatch}>
                End match &amp; review
              </button>
            )}
            {!cameraOn && support?.supported && status !== 'starting' && (
              <button type="button" className="btn btn--ghost" onClick={enableCamera}>
                Enable camera
              </button>
            )}
          </div>

          <div className="divider" />

          <div className="btn-row">
            <button
              type="button"
              className="btn"
              onClick={saveReplay}
              disabled={!recording || elapsed < 500}
              title="Save the previous seconds that are already buffered"
            >
              Save replay ({bufferSeconds}s)
            </button>
            <button
              type="button"
              className="btn btn--ghost"
              onClick={() => addMarker('disputed', '')}
              disabled={!recording}
            >
              Mark disputed point
            </button>
          </div>

          <p className="tiny muted" style={{ marginTop: 10 }}>
            {recording
              ? `${formatBytes(bytes)} written this session · ${bufferSeconds}s held in the replay buffer.`
              : 'Recording is independent of AI analysis: no upload, no network needed.'}
          </p>
        </div>

        <div className="card">
          <div className="card-head">
            <h3>Session clips</h3>
            <span className="tag">{savedClips.length}</span>
            {matchRef.current && (
              <Link href={`/match/${matchRef.current.id}`} className="btn btn--sm btn--ghost">
                Open review
              </Link>
            )}
          </div>
          <div className="list">
            {savedClips.length === 0 ? (
              <div className="empty">
                Replay clips you save appear here. Each one keeps its offset in the match so review lands on
                the right moment.
              </div>
            ) : (
              savedClips.map((clip) => (
                <div key={clip.id} className="list-row">
                  <div className="list-main">
                    <div className="list-title">
                      {clip.label}
                      <span className="tag">replay</span>
                    </div>
                    <div className="list-meta">
                      <span>{formatDuration(clip.durationMs)} (approx.)</span>
                      <span>·</span>
                      <span>{formatBytes(clip.sizeBytes)}</span>
                    </div>
                  </div>
                  <div className="list-actions">
                    <button
                      type="button"
                      className="btn btn--sm btn--ghost"
                      onClick={() =>
                        downloadBlob(
                          clip.blob,
                          `courtvision-replay-${new Date(clip.createdAt).toISOString().slice(11, 19).replace(/:/g, '')}.webm`,
                        )
                      }
                    >
                      Download
                    </button>
                  </div>
                </div>
              ))
            )}
          </div>
        </div>
      </div>

      <aside className="control-stack">
        <div className="card">
          <div className="card-head">
            <h3>Session setup</h3>
          </div>
          <div className="control-stack">
            <div className="field">
              <label htmlFor="match-name">Match name</label>
              <input
                id="match-name"
                className="input"
                value={matchName}
                placeholder={defaultName || 'Match name'}
                onChange={(event) => setMatchName(event.target.value)}
                disabled={setupLocked}
              />
            </div>
            <div className="field-row">
              <div className="field">
                <label htmlFor="match-format">Court</label>
                <select
                  id="match-format"
                  className="select"
                  value={format}
                  onChange={(event) => setFormat(event.target.value as MatchFormat)}
                  disabled={setupLocked}
                >
                  <option value="singles">Singles</option>
                  <option value="doubles">Doubles</option>
                </select>
              </div>
              <div className="field">
                <label htmlFor="buffer">Replay buffer</label>
                <select
                  id="buffer"
                  className="select"
                  value={bufferSeconds}
                  onChange={(event) => setBufferSeconds(Number(event.target.value))}
                  disabled={setupLocked}
                >
                  {BUFFER_OPTIONS.map((option) => (
                    <option key={option} value={option}>
                      {option}s
                    </option>
                  ))}
                </select>
              </div>
            </div>
            <label className="checkbox">
              <input
                type="checkbox"
                checked={lowPower}
                onChange={(event) => setLowPower(event.target.checked)}
                disabled={setupLocked || cameraOn}
              />
              Low-power mode (720p, less heat) — applies at camera start
            </label>
            <div className="key-value">
              <span>Camera support</span>
              <span>
                {support === null ? 'Checking…' : support.supported ? 'Available' : 'Unavailable'}
              </span>
            </div>
            {storage && (
              <div className="key-value">
                <span>Device storage</span>
                <span>
                  {formatBytes(storage.usageBytes)} / {formatBytes(storage.quotaBytes)}
                </span>
              </div>
            )}
          </div>
        </div>

        <div className="card">
          <div className="card-head">
            <h3>Markers &amp; notes</h3>
            <span className="tag">{markers.length}</span>
          </div>
          <div className="field" style={{ marginBottom: 10 }}>
            <input
              className="input"
              placeholder="Note for this moment…"
              value={note}
              onChange={(event) => setNote(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && note.trim()) addMarker('note', note.trim());
              }}
            />
          </div>
          <button
            type="button"
            className="btn btn--sm btn--block"
            onClick={() => addMarker('note', note.trim())}
            disabled={!note.trim() || !recording}
          >
            Add note at current time
          </button>
          <div className="marker-list" style={{ marginTop: 10 }}>
            {markers.length === 0 ? (
              <p className="small muted">
                Mark disputed points while recording; they are listed here with match timestamps.
              </p>
            ) : (
              markers.map((marker) => (
                <div key={marker.id} className="marker-row">
                  <span>
                    {marker.kind === 'disputed' ? 'Disputed point' : marker.note || 'Note'}
                  </span>
                  <span className="mono muted">{formatTimecode(marker.atMs, false)}</span>
                </div>
              ))
            )}
          </div>
        </div>

        <div className="notice notice--warn">
          <p>
            <strong>Experimental officiating.</strong> After recording, you can run an on-device analysis
            that proposes bounce candidates. Calls are estimates with an uncertainty band and frequently
            return <span className="mono">UNCERTAIN</span>. Never treat them as official decisions.
          </p>
          <p>
            Sustained recording drains battery and heats the phone. Low-power mode is there for long
            sessions on mid-range devices.
          </p>
        </div>
      </aside>
    </div>
  );
}
