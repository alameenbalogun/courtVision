'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { deleteMatch, listMatches, listMedia, storageInfo, type StorageInfo } from '@/lib/db';
import { formatBytes, formatDuration } from '@/lib/utils';
import type { MatchRecord } from '@/lib/types';

interface MatchSummary {
  match: MatchRecord;
  clipCount: number;
  matchCount: number;
  replayCount: number;
  bytes: number;
  lastAt: number;
}

export function MatchList() {
  const [items, setItems] = useState<MatchSummary[]>([]);
  const [storage, setStorage] = useState<StorageInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const matches = await listMatches();
      const summaries: MatchSummary[] = [];
      for (const match of matches) {
        const media = await listMedia(match.id);
        summaries.push({
          match,
          clipCount: media.length,
          matchCount: media.filter((m) => m.kind === 'match').length,
          replayCount: media.filter((m) => m.kind === 'replay').length,
          bytes: media.reduce((sum, m) => sum + m.sizeBytes, 0),
          lastAt: media.reduce((latest, m) => Math.max(latest, m.createdAt), match.createdAt),
        });
      }
      setItems(summaries);
      setStorage(await storageInfo());
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const remove = async (id: string) => {
    if (!window.confirm('Delete this session and its local clips? This cannot be undone.')) return;
    await deleteMatch(id);
    await load();
  };

  if (loading) return <p className="loading">Loading local sessions…</p>;

  if (error) {
    return (
      <div className="notice notice--danger">
        <strong>Local storage is unavailable.</strong>
        <p>{error}</p>
      </div>
    );
  }

  return (
    <div className="list">
      {items.length === 0 ? (
        <div className="empty">
          No sessions yet. Open the recorder, grant camera access, and start a match — clips are stored on
          this device only.
        </div>
      ) : (
        items.map(({ match, replayCount, matchCount, bytes, lastAt }) => (
          <div key={match.id} className="list-row">
            <div className="list-main">
              <div className="list-title">
                <Link href={`/match/${match.id}`}>{match.name}</Link>
                <span className="tag">{match.format}</span>
                {match.calibration ? (
                  <span className="tag tag--lime">Calibrated</span>
                ) : (
                  <span className="tag">No calibration</span>
                )}
              </div>
              <div className="list-meta">
                <span>{new Date(lastAt).toLocaleString()}</span>
                <span>·</span>
                <span>
                  {matchCount} recording{matchCount === 1 ? '' : 's'}, {replayCount} replay
                  {replayCount === 1 ? '' : 's'}
                </span>
                <span>·</span>
                <span>{formatBytes(bytes)}</span>
                {match.markers.length > 0 && (
                  <>
                    <span>·</span>
                    <span>{match.markers.length} markers</span>
                  </>
                )}
              </div>
            </div>
            <div className="list-actions">
              <Link href={`/match/${match.id}`} className="btn btn--sm">
                Review
              </Link>
              <button type="button" className="btn btn--sm btn--ghost" onClick={() => remove(match.id)}>
                Delete
              </button>
            </div>
          </div>
        ))
      )}

      {storage && (
        <p className="tiny muted">
          Device storage used by this browser: {formatBytes(storage.usageBytes)} of{' '}
          {formatBytes(storage.quotaBytes)} available. Long matches can be large — export and delete
          footage you no longer need.
        </p>
      )}
    </div>
  );
}
