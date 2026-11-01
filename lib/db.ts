import type { MatchRecord, MediaRecord, AnalysisResult, RecordedChunk } from './types';

const DB_NAME = 'courtvision';
const DB_VERSION = 2;

const STORES = {
  matches: 'matches',
  media: 'media',
  analysis: 'analysis',
  chunks: 'chunks',
} as const;

let dbPromise: Promise<IDBDatabase> | null = null;

function openDb(): Promise<IDBDatabase> {
  if (typeof indexedDB === 'undefined') {
    return Promise.reject(new Error('IndexedDB is not available in this browser.'));
  }
  if (dbPromise) return dbPromise;

  dbPromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORES.matches)) {
        db.createObjectStore(STORES.matches, { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains(STORES.media)) {
        const media = db.createObjectStore(STORES.media, { keyPath: 'id' });
        media.createIndex('matchId', 'matchId', { unique: false });
      }
      if (!db.objectStoreNames.contains(STORES.analysis)) {
        const analysis = db.createObjectStore(STORES.analysis, { keyPath: 'mediaId' });
        analysis.createIndex('matchId', 'matchId', { unique: false });
      }
      if (!db.objectStoreNames.contains(STORES.chunks)) {
        const chunks = db.createObjectStore(STORES.chunks, { keyPath: 'id' });
        chunks.createIndex('mediaId', 'mediaId', { unique: false });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('Could not open local storage.'));
    request.onblocked = () => reject(new Error('Another tab is holding the storage open. Close it and retry.'));
  });

  return dbPromise;
}

function run<T>(
  store: string,
  mode: IDBTransactionMode,
  work: (s: IDBObjectStore) => IDBRequest,
): Promise<T> {
  return openDb().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const tx = db.transaction(store, mode);
        const request = work(tx.objectStore(store));
        request.onsuccess = () => resolve(request.result as T);
        request.onerror = () => reject(request.error ?? new Error('Local storage request failed.'));
        tx.onabort = () => reject(tx.error ?? new Error('Local storage transaction aborted.'));
      }),
  );
}

// --------------------------------------------------------------------------- //
// Matches
// --------------------------------------------------------------------------- //

export async function saveMatch(match: MatchRecord): Promise<void> {
  await run<IDBValidKey>(STORES.matches, 'readwrite', (s) => s.put(match));
}

export async function getMatch(id: string): Promise<MatchRecord | undefined> {
  const match = await run<MatchRecord | undefined>(STORES.matches, 'readonly', (s) => s.get(id));
  return match ? migrateMatch(match) : undefined;
}

export async function listMatches(): Promise<MatchRecord[]> {
  const matches = await run<MatchRecord[]>(STORES.matches, 'readonly', (s) => s.getAll());
  return matches.map(migrateMatch).sort((a, b) => b.createdAt - a.createdAt);
}

export async function deleteMatch(id: string): Promise<void> {
  const media = await listMedia(id);
  for (const item of media) {
    await deleteMedia(item.id);
  }
  await run<undefined>(STORES.matches, 'readwrite', (s) => s.delete(id));
}

function migrateMatch(match: MatchRecord): MatchRecord {
  return {
    ...match,
    markers: match.markers ?? [],
    cloudState: match.cloudState ?? 'none',
  };
}

// --------------------------------------------------------------------------- //
// Media
// --------------------------------------------------------------------------- //

export async function saveMedia(media: MediaRecord): Promise<void> {
  await run<IDBValidKey>(STORES.media, 'readwrite', (s) => s.put(media));
}

export async function getMedia(id: string): Promise<MediaRecord | undefined> {
  const media = await run<MediaRecord | undefined>(STORES.media, 'readonly', (s) => s.get(id));
  return media ? migrateMedia(media) : undefined;
}

export async function listMedia(matchId: string): Promise<MediaRecord[]> {
  const media = await run<MediaRecord[]>(STORES.media, 'readonly', (s) =>
    s.index('matchId').getAll(matchId),
  );
  return media.map(migrateMedia).sort((a, b) => b.createdAt - a.createdAt);
}

export async function deleteMedia(id: string): Promise<void> {
  await deleteChunks(id);
  await run<undefined>(STORES.media, 'readwrite', (s) => s.delete(id));
  await run<undefined>(STORES.analysis, 'readwrite', (s) => s.delete(id));
}

function migrateMedia(media: MediaRecord): MediaRecord {
  return {
    ...media,
    startMs: media.startMs ?? 0,
    status: media.status ?? 'ready',
    cloudState: media.cloudState ?? 'none',
    blob: media.blob ?? null,
  };
}

/** Media whose recording was interrupted (crash, reload, tab close). */
export async function listInterruptedRecordings(): Promise<MediaRecord[]> {
  const all = await run<MediaRecord[]>(STORES.media, 'readonly', (s) => s.getAll());
  return all.map(migrateMedia).filter((item) => item.status === 'recording');
}

// --------------------------------------------------------------------------- //
// Recording chunks (durable write path)
// --------------------------------------------------------------------------- //

export async function putChunk(chunk: RecordedChunk): Promise<void> {
  const record = { ...chunk, id: `${chunk.mediaId}:${String(chunk.seq).padStart(6, '0')}` };
  await run<IDBValidKey>(STORES.chunks, 'readwrite', (s) => s.put(record));
}

export async function listChunks(mediaId: string): Promise<RecordedChunk[]> {
  const chunks = await run<RecordedChunk[]>(STORES.chunks, 'readonly', (s) =>
    s.index('mediaId').getAll(mediaId),
  );
  return chunks.sort((a, b) => a.seq - b.seq);
}

export async function deleteChunks(mediaId: string): Promise<void> {
  const index = await openDb().then(
    (db) =>
      new Promise<void>((resolve, reject) => {
        const tx = db.transaction(STORES.chunks, 'readwrite');
        const store = tx.objectStore(STORES.chunks);
        const request = store.index('mediaId').openKeyCursor(IDBKeyRange.only(mediaId));
        request.onsuccess = () => {
          const cursor = request.result;
          if (!cursor) return;
          store.delete(cursor.primaryKey);
          cursor.continue();
        };
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error);
      }),
  );
  return index;
}

export interface AssembledRecording {
  blob: Blob;
  sizeBytes: number;
  mimeType: string;
  durationMs: number;
}

/**
 * Rebuilds a recording from its on-disk chunks. Chunk windows are stored at
 * write time, so a recovered clip keeps its real match duration instead of a
 * timeslice guess.
 */
export async function assembleRecording(media: MediaRecord): Promise<AssembledRecording | null> {
  const chunks = await listChunks(media.id);
  if (chunks.length === 0) return null;

  const type = media.mimeType || 'video/webm';
  const blob = new Blob(
    chunks.map((chunk) => chunk.blob),
    { type },
  );
  const first = chunks[0];
  const last = chunks[chunks.length - 1];
  const sizeBytes = chunks.reduce((sum, chunk) => sum + chunk.size, 0);
  const durationMs = Math.max(media.durationMs, last.endMs - first.startMs);

  // The blob above holds its own references to the chunk data, so the durable
  // copies can be dropped immediately after assembly.
  await deleteChunks(media.id);

  return { blob, sizeBytes, mimeType: type, durationMs };
}

/** Assembles an interrupted recording and turns it into a playable clip. */
export async function recoverRecording(mediaId: string): Promise<MediaRecord | null> {
  const media = await getMedia(mediaId);
  if (!media) return null;
  const assembled = await assembleRecording(media);
  if (!assembled) {
    await deleteMedia(mediaId);
    return null;
  }
  const recovered: MediaRecord = {
    ...media,
    blob: assembled.blob,
    sizeBytes: assembled.sizeBytes,
    mimeType: assembled.mimeType,
    durationMs: assembled.durationMs,
    status: 'ready',
    cloudState: 'none',
    cloudPath: null,
    cloudError: null,
  };
  await saveMedia(recovered);
  return recovered;
}

// --------------------------------------------------------------------------- //
// Analysis
// --------------------------------------------------------------------------- //

export async function saveAnalysis(result: AnalysisResult): Promise<void> {
  await run<IDBValidKey>(STORES.analysis, 'readwrite', (s) => s.put(result));
}

export async function getAnalysis(mediaId: string): Promise<AnalysisResult | undefined> {
  return run<AnalysisResult | undefined>(STORES.analysis, 'readonly', (s) => s.get(mediaId));
}

export async function listAnalyses(matchId: string): Promise<AnalysisResult[]> {
  return run<AnalysisResult[]>(STORES.analysis, 'readonly', (s) => s.index('matchId').getAll(matchId));
}

// --------------------------------------------------------------------------- //
// Storage
// --------------------------------------------------------------------------- //

export interface StorageInfo {
  usageBytes: number;
  quotaBytes: number;
}

export async function storageInfo(): Promise<StorageInfo | null> {
  if (typeof navigator === 'undefined' || !navigator.storage?.estimate) return null;
  try {
    const estimate = await navigator.storage.estimate();
    return { usageBytes: estimate.usage ?? 0, quotaBytes: estimate.quota ?? 0 };
  } catch {
    return null;
  }
}
