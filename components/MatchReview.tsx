'use client';

import Link from 'next/link';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { CourtOverlay } from './CourtOverlay';
import { analyzeMedia } from '@/lib/analysis';
import { buildCalibration, calibrationQuality, MIN_CALIBRATION_POINTS } from '@/lib/calibration';
import { CALIBRATION_TARGETS, getCalibrationTarget } from '@/lib/court';
import { deleteMedia, getAnalysis, getMatch, listMedia, saveAnalysis, saveMatch } from '@/lib/db';
import { downloadBlob, downloadJson, exportSegment } from '@/lib/export';
import { clamp, formatBytes, formatDuration, formatTimecode, pct } from '@/lib/utils';
import type {
  AnalysisProgress,
  AnalysisResult,
  CalibrationPoint,
  MatchRecord,
  MediaRecord,
} from '@/lib/types';

const ASSUMED_FPS = 30;

function callClass(call: string): string {
  if (call === 'IN') return 'tag tag--in';
  if (call === 'OUT') return 'tag tag--out';
  return 'tag tag--uncertain';
}

function safeName(value: string): string {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 48) || 'courtvision'
  );
}

function extensionFor(mimeType: string): string {
  return mimeType.includes('mp4') ? 'mp4' : 'webm';
}

export function MatchReview({ matchId }: { matchId: string }) {
  const videoRef = useRef<HTMLVideoElement | null>(null);

  const [match, setMatch] = useState<MatchRecord | null>(null);
  const [clips, setClips] = useState<MediaRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [blobUrl, setBlobUrl] = useState<string | null>(null);
  const [frameSize, setFrameSize] = useState<{ width: number; height: number } | null>(null);
  const [duration, setDuration] = useState(0);
  const [currentTime, setCurrentTime] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [rate, setRate] = useState(1);
  const [tab, setTab] = useState<'review' | 'calibrate'>('review');
  const [points, setPoints] = useState<CalibrationPoint[]>([]);
  const [markTargetId, setMarkTargetId] = useState<string | null>(null);
  const [calibrationError, setCalibrationError] = useState<string | null>(null);
  const [savingCalibration, setSavingCalibration] = useState(false);
  const [analysis, setAnalysis] = useState<AnalysisResult | null>(null);
  const [analysisError, setAnalysisError] = useState<string | null>(null);
  const [analyzing, setAnalyzing] = useState(false);
  const [progress, setProgress] = useState<AnalysisProgress | null>(null);
  const [activeEventId, setActiveEventId] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);

  const load = useCallback(async () => {
    const found = await getMatch(matchId);
    if (!found) {
      setNotFound(true);
      setLoading(false);
      return;
    }
    setMatch(found);
    setPoints(found.calibration?.points ?? []);
    const media = await listMedia(matchId);
    setClips(media);
    setSelectedId((current) => current ?? media[0]?.id ?? null);
    setLoading(false);
  }, [matchId]);

  useEffect(() => {
    load();
  }, [load]);

  const selectedClip = clips.find((clip) => clip.id === selectedId) ?? null;

  useEffect(() => {
    if (!selectedClip) {
      setBlobUrl(null);
      return;
    }
    const url = URL.createObjectURL(selectedClip.blob);
    setBlobUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [selectedClip]);

  useEffect(() => {
    setCurrentTime(0);
    setDuration(0);
    setPlaying(false);
    setFrameSize(null);
    setActiveEventId(null);
    setAnalysisError(null);
  }, [selectedId]);

  useEffect(() => {
    let cancelled = false;
    setAnalysis(null);
    if (!selectedId) return;
    getAnalysis(selectedId)
      .then((result) => {
        if (!cancelled) setAnalysis(result ?? null);
      })
      .catch(() => {
        if (!cancelled) setAnalysis(null);
      });
    return () => {
      cancelled = true;
    };
  }, [selectedId]);

  const seekMs = useCallback((ms: number) => {
    const video = videoRef.current;
    if (!video) return;
    const maxMs = Number.isFinite(video.duration) ? video.duration * 1000 : ms;
    const target = clamp(ms, 0, Math.max(0, maxMs - 20));
    video.currentTime = target / 1000;
    setCurrentTime(target);
  }, []);

  const togglePlay = useCallback(() => {
    const video = videoRef.current;
    if (!video) return;
    if (video.paused) void video.play().catch(() => undefined);
    else video.pause();
  }, []);

  const stepFrame = (direction: 1 | -1) => {
    const video = videoRef.current;
    if (!video) return;
    video.pause();
    seekMs(currentTime + (direction * 1000) / ASSUMED_FPS);
  };

  const previewFrame = frameSize ?? match?.calibration?.frame ?? null;
  const previewBuild = useMemo(() => {
    if (!previewFrame || points.length < MIN_CALIBRATION_POINTS) return { calibration: null, error: undefined };
    return buildCalibration(points, previewFrame);
  }, [points, previewFrame]);

  const activeTarget = useMemo(() => {
    const fallback = CALIBRATION_TARGETS.find(
      (target) => !points.some((point) => point.targetId === target.id),
    );
    const id = markTargetId ?? fallback?.id;
    return CALIBRATION_TARGETS.find((target) => target.id === id) ?? null;
  }, [markTargetId, points]);

  const activeEvent = analysis?.bounces.find((bounce) => bounce.id === activeEventId) ?? null;
  const clipAnalysisHint = analysis ? `${analysis.bounces.length} candidates` : 'not analysed';

  const handleStageClick = (event: React.MouseEvent<HTMLDivElement>) => {
    if (tab === 'calibrate') {
      if (!activeTarget) return;
      const rect = event.currentTarget.getBoundingClientRect();
      const x = clamp((event.clientX - rect.left) / rect.width, 0, 1);
      const y = clamp((event.clientY - rect.top) / rect.height, 0, 1);
      setPoints((prev) => [
        ...prev.filter((point) => point.targetId !== activeTarget.id),
        { targetId: activeTarget.id, image: { x, y } },
      ]);
      setMarkTargetId(null);
      setCalibrationError(null);
      return;
    }
    togglePlay();
  };

  const saveCalibration = async () => {
    if (!match || !previewFrame) return;
    setSavingCalibration(true);
    const { calibration, error } = buildCalibration(points, previewFrame);
    if (!calibration) {
      setCalibrationError(error ?? 'Calibration failed.');
      setSavingCalibration(false);
      return;
    }
    const updated: MatchRecord = { ...match, calibration };
    await saveMatch(updated);
    setMatch(updated);
    setCalibrationError(null);
    setMessage(
      `Calibration saved (${calibration.reprojectionErrorPx.toFixed(1)} px RMS). Court overlays and AI estimates now use it.`,
    );
    setSavingCalibration(false);
  };

  const runAnalysis = async () => {
    if (!selectedClip || !match) return;
    setAnalyzing(true);
    setAnalysisError(null);
    setMessage(null);
    setProgress({ phase: 'sampling', framesAnalysed: 0, totalFrames: 0 });
    try {
      const result = await analyzeMedia(selectedClip.blob, {
        mediaId: selectedClip.id,
        matchId: match.id,
        format: match.format,
        calibration: match.calibration,
        onProgress: setProgress,
      });
      await saveAnalysis(result);
      setAnalysis(result);
      setMessage(
        result.bounces.length > 0
          ? `${result.bounces.length} candidate bounce${result.bounces.length === 1 ? '' : 's'} found.`
          : 'Analysis finished without a candidate bounce.',
      );
    } catch (err) {
      setAnalysisError((err as Error).message);
    } finally {
      setAnalyzing(false);
      setProgress(null);
    }
  };

  const removeClip = async (clip: MediaRecord) => {
    if (!window.confirm(`Delete “${clip.label}” from this device? This cannot be undone.`)) return;
    await deleteMedia(clip.id);
    const media = await listMedia(matchId);
    setClips(media);
    setSelectedId((current) => (current === clip.id ? media[0]?.id ?? null : current));
  };

  const exportAround = async () => {
    const video = videoRef.current;
    if (!video || !selectedClip) return;
    setExporting(true);
    setMessage(null);
    try {
      const startSec = Math.max(0, currentTime / 1000 - 2.5);
      await exportSegment(
        video,
        startSec,
        startSec + 5,
        `${safeName(match?.name ?? 'courtvision')}-${Math.round(startSec)}s.webm`,
      );
      setMessage('Segment export started — the browser will download the file when it is ready.');
    } catch (err) {
      setMessage((err as Error).message);
    } finally {
      setExporting(false);
    }
  };

  if (loading) return <p className="loading">Opening session…</p>;

  if (notFound) {
    return (
      <div className="notice notice--danger">
        <strong>Session not found.</strong>
        <p>
          It may have been deleted from this device. <Link href="/">Back to sessions</Link>.
        </p>
      </div>
    );
  }

  if (!match) return null;

  const quality = calibrationQuality(match.calibration);
  const previewQuality = calibrationQuality(previewBuild.calibration);

  return (
    <>
      <div className="review-head">
        <div>
          <Link href="/" className="small muted">
            ← All sessions
          </Link>
          <h1 style={{ marginTop: 6 }}>{match.name}</h1>
          <div className="review-meta">
            <span>{new Date(match.createdAt).toLocaleString()}</span>
            <span>·</span>
            <span className="tag">{match.format}</span>
            <span className={`tag ${quality.tone === 'good' ? 'tag--lime' : quality.tone === 'warn' ? 'tag--uncertain' : ''}`}>
              {quality.label}
            </span>
            <span>·</span>
            <span>
              {clips.length} clip{clips.length === 1 ? '' : 's'}
            </span>
          </div>
        </div>
        <div className="spacer" />
        <Link href="/record" className="btn btn--primary">
          New session
        </Link>
      </div>

      {message && (
        <div className="notice" style={{ marginBottom: 14 }}>
          {message}
        </div>
      )}

      <div className="review-grid">
        <section className="card card--flush">
          {selectedClip && blobUrl ? (
            <>
              <div
                className={`stage ${tab === 'calibrate' ? 'stage--marking' : ''}`}
                style={{ aspectRatio: frameSize ? `${frameSize.width} / ${frameSize.height}` : '16 / 9' }}
                onClick={handleStageClick}
              >
                <video
                  ref={videoRef}
                  className="stage-video"
                  src={blobUrl}
                  playsInline
                  muted
                  preload="auto"
                  onLoadedMetadata={(event) => {
                    const video = event.currentTarget;
                    setFrameSize({ width: video.videoWidth, height: video.videoHeight });
                    setDuration(Number.isFinite(video.duration) ? video.duration * 1000 : 0);
                  }}
                  onTimeUpdate={(event) => setCurrentTime(event.currentTarget.currentTime * 1000)}
                  onPlay={() => setPlaying(true)}
                  onPause={() => setPlaying(false)}
                  onError={() => setAnalysisError('This clip could not be played by the browser.')}
                  crossOrigin="anonymous"
                />

                {match.calibration && (
                  <div className="stage-overlay">
                    <CourtOverlay calibration={match.calibration} />
                  </div>
                )}

                {tab === 'calibrate' && (
                  <div className="stage-overlay">
                    {points.map((point) => {
                      const target = getCalibrationTarget(point.targetId);
                      return (
                        <div
                          key={point.targetId}
                          className={`marker-dot ${activeTarget?.id === point.targetId ? 'marker-dot--active' : ''}`}
                          style={{ left: `${point.image.x * 100}%`, top: `${point.image.y * 100}%` }}
                          title={target?.label}
                        >
                          {target?.short}
                        </div>
                      );
                    })}
                  </div>
                )}

                {activeEvent && (
                  <div
                    className="bounce-ring"
                    style={{
                      left: `${activeEvent.imagePoint.x * 100}%`,
                      top: `${activeEvent.imagePoint.y * 100}%`,
                    }}
                  />
                )}

                <div className="stage-hud">
                  <span className="hud-item hud-timer">{formatTimecode(currentTime)}</span>
                  {rate !== 1 && <span className="hud-item">{rate}×</span>}
                  {tab === 'calibrate' && activeTarget && (
                    <span className="hud-item">Tap: {activeTarget.label}</span>
                  )}
                </div>
              </div>

              <div className="player-bar">
                <button type="button" className="btn btn--sm" onClick={togglePlay}>
                  {playing ? 'Pause' : 'Play'}
                </button>
                <button type="button" className="btn btn--sm" onClick={() => stepFrame(-1)} title="Previous frame">
                  ◀ frame
                </button>
                <button type="button" className="btn btn--sm" onClick={() => stepFrame(1)} title="Next frame">
                  frame ▶
                </button>
                <select
                  className="select"
                  style={{ width: 'auto' }}
                  value={rate}
                  onChange={(event) => {
                    const value = Number(event.target.value);
                    setRate(value);
                    if (videoRef.current) videoRef.current.playbackRate = value;
                  }}
                  aria-label="Playback speed"
                >
                  <option value={0.25}>0.25×</option>
                  <option value={0.5}>0.5×</option>
                  <option value={1}>1×</option>
                </select>
                <input
                  className="scrub"
                  type="range"
                  min={0}
                  max={Math.max(1, duration)}
                  step={1}
                  value={Math.min(currentTime, duration)}
                  aria-label="Scrub"
                  onChange={(event) => {
                    videoRef.current?.pause();
                    seekMs(Number(event.target.value));
                  }}
                />
                <span className="timecode">
                  {formatTimecode(currentTime)} / {formatTimecode(duration, false)}
                </span>
              </div>

              <div className="player-actions">
                <button
                  type="button"
                  className="btn btn--sm"
                  onClick={() =>
                    downloadBlob(
                      selectedClip.blob,
                      `${safeName(match.name)}-${selectedClip.kind}.${extensionFor(selectedClip.mimeType)}`,
                    )
                  }
                >
                  Download clip
                </button>
                <button type="button" className="btn btn--sm" onClick={exportAround} disabled={exporting}>
                  {exporting ? 'Exporting…' : 'Export ±2.5s'}
                </button>
                <button
                  type="button"
                  className="btn btn--sm btn--ghost"
                  onClick={runAnalysis}
                  disabled={analyzing}
                >
                  {analyzing ? 'Analysing…' : 'Analyse clip'}
                </button>
                <div className="spacer" />
                <button
                  type="button"
                  className="btn btn--sm btn--ghost"
                  onClick={() => removeClip(selectedClip)}
                >
                  Delete clip
                </button>
              </div>
            </>
          ) : (
            <div className="empty" style={{ margin: 18 }}>
              This session has no clips. Record one from the live session screen.
            </div>
          )}
        </section>

        <aside className="control-stack">
          <div className="card">
            <div className="card-head">
              <h3>Clips</h3>
              <span className="tag">{clips.length}</span>
            </div>
            <div className="list">
              {clips.length === 0 ? (
                <div className="empty">No clips stored for this session.</div>
              ) : (
                clips.map((clip) => (
                  <button
                    key={clip.id}
                    type="button"
                    className={`list-row event--button ${clip.id === selectedId ? 'list-row--active' : ''}`}
                    onClick={() => setSelectedId(clip.id)}
                    style={{ textAlign: 'left' }}
                  >
                    <div className="list-main">
                      <div className="list-title">
                        {clip.label}
                        <span className={clip.kind === 'replay' ? 'tag tag--lime' : 'tag'}>{clip.kind}</span>
                      </div>
                      <div className="list-meta">
                        <span>{formatDuration(clip.durationMs)}</span>
                        <span>·</span>
                        <span>{formatBytes(clip.sizeBytes)}</span>
                        <span>·</span>
                        <span>{clip.id === selectedId ? clipAnalysisHint : 'select to review'}</span>
                      </div>
                    </div>
                  </button>
                ))
              )}
            </div>
          </div>

          <div className="card">
            <div className="tabs">
              <button
                type="button"
                className={`tab ${tab === 'review' ? 'tab--active' : ''}`}
                onClick={() => setTab('review')}
              >
                AI review
              </button>
              <button
                type="button"
                className={`tab ${tab === 'calibrate' ? 'tab--active' : ''}`}
                onClick={() => {
                  setTab('calibrate');
                  videoRef.current?.pause();
                }}
              >
                Court calibration
              </button>
            </div>

            {tab === 'review' ? (
              <div className="control-stack">
                {analysisError && (
                  <div className="notice notice--danger">
                    <strong>Analysis problem.</strong>
                    <p>{analysisError}</p>
                  </div>
                )}

                {analyzing && (
                  <div>
                    <p className="small muted" style={{ marginBottom: 8 }}>
                      {progress?.phase === 'sampling'
                        ? `Sampling frames ${progress.framesAnalysed}/${progress.totalFrames}…`
                        : progress?.phase === 'evidence'
                          ? 'Capturing evidence frames…'
                          : 'Linking tracks and proposing bounce events…'}
                    </p>
                    <div className="progress">
                      <div
                        className="progress-bar"
                        style={{
                          width: `${
                            progress && progress.totalFrames > 0
                              ? Math.round((progress.framesAnalysed / progress.totalFrames) * 100)
                              : 5
                          }%`,
                        }}
                      />
                    </div>
                    <p className="tiny muted" style={{ marginTop: 8 }}>
                      Analysis runs on this device and never interrupts recording.
                    </p>
                  </div>
                )}

                {!selectedClip && <div className="empty">Select a clip to analyse.</div>}

                {selectedClip && !analysis && !analyzing && (
                  <>
                    <p className="small muted">
                      The baseline pass samples frames, finds tennis-ball coloured blobs, links them into
                      tracks, and proposes bounce candidates. Court calls need a saved calibration.
                    </p>
                    <button
                      type="button"
                      className="btn btn--primary btn--block"
                      onClick={runAnalysis}
                      disabled={analyzing}
                    >
                      Analyse this clip
                    </button>
                    <p className="tiny muted">
                      Best effort, experimental. If footage is blurred or the ball is occluded, expect an
                      empty or UNCERTAIN result.
                    </p>
                  </>
                )}

                {analysis && (
                  <>
                    <div className="stat-grid">
                      <div className="stat">
                        <div className="stat-value">{analysis.framesAnalyzed}</div>
                        <div className="stat-label">frames sampled</div>
                      </div>
                      <div className="stat">
                        <div className="stat-value">
                          {pct(analysis.framesWithBall / Math.max(1, analysis.framesAnalyzed))}
                        </div>
                        <div className="stat-label">ball coverage</div>
                      </div>
                      <div className="stat">
                        <div className="stat-value">{analysis.bounces.length}</div>
                        <div className="stat-label">bounce candidates</div>
                      </div>
                      <div className="stat">
                        <div className="stat-value">
                          {Number.isFinite(analysis.calibrationErrorPx)
                            ? `${analysis.calibrationErrorPx.toFixed(1)} px`
                            : '—'}
                        </div>
                        <div className="stat-label">calibration fit</div>
                      </div>
                    </div>

                    <div className="tiny muted">
                      Detector: {analysis.detector} · {analysis.tracks.length} tracks ·{' '}
                      {formatDuration(analysis.clipDurationMs)} clip
                    </div>

                    {analysis.warnings.map((warning) => (
                      <div key={warning} className="notice notice--warn">
                        {warning}
                      </div>
                    ))}

                    {!match.calibration && analysis.bounces.length > 0 && (
                      <div className="notice notice--warn">
                        Save a court calibration to get bounce locations and line calls.
                      </div>
                    )}

                    <div className="events">
                      {analysis.bounces.length === 0 ? (
                        <div className="empty">
                          No candidate bounce detected. Try a clip with the ball clearly visible against the
                          court, or review the point frame by frame instead.
                        </div>
                      ) : (
                        analysis.bounces.map((bounce) => (
                          <button
                            key={bounce.id}
                            type="button"
                            className={`event event--button ${activeEventId === bounce.id ? 'event--active' : ''}`}
                            onClick={() => {
                              setActiveEventId(bounce.id);
                              videoRef.current?.pause();
                              seekMs(bounce.timeMs - 300);
                            }}
                          >
                            <div className="event-top">
                              <span className={callClass(bounce.lineCall)}>{bounce.lineCall}</span>
                              <span className="event-time">{formatTimecode(bounce.timeMs)}</span>
                              <span className="tag">confidence {pct(bounce.confidence)}</span>
                            </div>
                            <div className="event-meta">
                              {bounce.courtPoint ? (
                                <span>
                                  court {bounce.courtPoint.x.toFixed(2)} m, {bounce.courtPoint.y.toFixed(2)} m
                                </span>
                              ) : (
                                <span>court position unavailable</span>
                              )}
                              {bounce.distanceToLineM !== null && (
                                <span>
                                  {(bounce.distanceToLineM * 100).toFixed(0)} cm from{' '}
                                  {bounce.nearestLine ?? 'line'}
                                </span>
                              )}
                              {bounce.sigmaM !== null && (
                                <span>±{(bounce.sigmaM * 100).toFixed(0)} cm (1σ)</span>
                              )}
                            </div>
                            <div className="flags">
                              {bounce.qualityFlags.map((flag) => (
                                <span key={flag} className="flag">
                                  {flag}
                                </span>
                              ))}
                            </div>
                            {bounce.evidence.length > 0 && (
                              <div className="evidence">
                                {bounce.evidence.map((frame) => (
                                  <figure key={`${bounce.id}-${frame.timeMs}`}>
                                    {/* eslint-disable-next-line @next/next/no-img-element */}
                                    <img src={frame.dataUrl} alt={`Evidence frame at ${formatTimecode(frame.timeMs)}`} />
                                    <figcaption>{formatTimecode(frame.timeMs, false)}</figcaption>
                                  </figure>
                                ))}
                              </div>
                            )}
                          </button>
                        ))
                      )}
                    </div>

                    <div className="btn-row">
                      <button type="button" className="btn btn--sm" onClick={runAnalysis} disabled={analyzing}>
                        Re-run analysis
                      </button>
                      <button
                        type="button"
                        className="btn btn--sm btn--ghost"
                        onClick={() =>
                          downloadJson(
                            { match: { id: match.id, name: match.name, format: match.format }, ...analysis },
                            `${safeName(match.name)}-${selectedClip?.id ?? 'analysis'}.json`,
                          )
                        }
                      >
                        Download JSON
                      </button>
                    </div>

                    <p className="tiny muted">
                      Distances and uncertainty are shown so you can judge the call yourself. The evidence
                      frames above are the original footage, not a reconstruction.
                    </p>
                  </>
                )}

                {match.markers.length > 0 && (
                  <>
                    <div className="divider" />
                    <h3>Session markers</h3>
                    <div className="list">
                      {match.markers.map((marker) => (
                        <button
                          key={marker.id}
                          type="button"
                          className="marker-row event--button"
                          onClick={() => seekMs(marker.atMs - 2000)}
                          title="Jump to two seconds before this marker"
                        >
                          <span>
                            {marker.kind === 'disputed' ? 'Disputed point' : marker.note || 'Note'}
                          </span>
                          <span className="mono muted">{formatTimecode(marker.atMs, false)}</span>
                        </button>
                      ))}
                    </div>
                  </>
                )}
              </div>
            ) : (
              <div className="control-stack">
                <p className="small muted">
                  Pause on a frame where the lines are visible, then tap each court point on the video.
                  Four corners are enough to start; adding singles and net points improves the fit.
                </p>

                <div className="calib-targets">
                  {CALIBRATION_TARGETS.map((target) => {
                    const isSet = points.some((point) => point.targetId === target.id);
                    return (
                      <button
                        key={target.id}
                        type="button"
                        className={`calib-target ${isSet ? 'calib-target--set' : ''} ${
                          activeTarget?.id === target.id ? 'calib-target--active' : ''
                        }`}
                        onClick={() => setMarkTargetId(target.id)}
                      >
                        <span className="dot" />
                        <span>{target.label}</span>
                        <span className="prio">{isSet ? 'set' : `tap to place`}</span>
                      </button>
                    );
                  })}
                </div>

                {activeTarget && (
                  <div className="notice">
                    Tap the <strong>{activeTarget.label}</strong> on the video.
                  </div>
                )}

                {calibrationError && (
                  <div className="notice notice--danger">
                    <strong>Calibration not saved.</strong>
                    <p>{calibrationError}</p>
                  </div>
                )}

                <div className="btn-row">
                  <button
                    type="button"
                    className="btn btn--sm"
                    onClick={() => setPoints((prev) => prev.slice(0, -1))}
                    disabled={points.length === 0}
                  >
                    Undo last
                  </button>
                  <button
                    type="button"
                    className="btn btn--sm btn--ghost"
                    onClick={() => {
                      setPoints([]);
                      setMarkTargetId(null);
                      setCalibrationError(null);
                    }}
                    disabled={points.length === 0}
                  >
                    Clear all
                  </button>
                  <button
                    type="button"
                    className="btn btn--sm btn--primary"
                    onClick={saveCalibration}
                    disabled={points.length < MIN_CALIBRATION_POINTS || savingCalibration}
                  >
                    {savingCalibration ? 'Saving…' : 'Save calibration'}
                  </button>
                </div>

                <div className="divider" />

                <div className="key-value">
                  <span>Points marked</span>
                  <span>{points.length}</span>
                </div>
                <div className="key-value">
                  <span>Saved calibration</span>
                  <span>{quality.label}</span>
                </div>
                <div className="key-value">
                  <span>Saved fit</span>
                  <span>
                    {match.calibration ? `${match.calibration.reprojectionErrorPx.toFixed(1)} px RMS` : '—'}
                  </span>
                </div>
                {previewBuild.calibration && (
                  <div className="key-value">
                    <span>Unsaved preview</span>
                    <span>
                      {previewBuild.calibration.reprojectionErrorPx.toFixed(1)} px RMS ({previewQuality.label})
                    </span>
                  </div>
                )}
                <div className="key-value">
                  <span>Calibrated at</span>
                  <span>
                    {match.calibration
                      ? `${match.calibration.frame.width}×${match.calibration.frame.height}`
                      : '—'}
                  </span>
                </div>

                <div className="notice notice--warn">
                  A court-plane homography cannot know how high the ball was when it was hit. Bounce
                  locations are inferred from where the ball appears at ground contact, so single-camera
                  calls near a line should almost always read UNCERTAIN.
                </div>
              </div>
            )}
          </div>
        </aside>
      </div>
    </>
  );
}
