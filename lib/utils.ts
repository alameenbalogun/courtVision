export function uid(prefix = ''): string {
  const rand =
    typeof crypto !== 'undefined' && 'randomUUID' in crypto
      ? crypto.randomUUID().slice(0, 8)
      : Math.random().toString(36).slice(2, 10);
  return `${prefix}${Date.now().toString(36)}${rand}`;
}

export function formatDuration(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  return `${m}:${String(s).padStart(2, '0')}`;
}

export function formatBytes(bytes: number): string {
  if (!bytes) return '0 MB';
  const mb = bytes / (1024 * 1024);
  if (mb >= 1024) return `${(mb / 1024).toFixed(1)} GB`;
  if (mb >= 1) return `${mb.toFixed(0)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

export function formatTimecode(ms: number, withMs = true): string {
  const safe = Math.max(0, ms);
  const minutes = Math.floor(safe / 60000);
  const seconds = Math.floor((safe % 60000) / 1000);
  const fraction = Math.floor(safe % 1000);
  const base = `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
  return withMs ? `${base}.${String(fraction).padStart(3, '0')}` : base;
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function pct(value: number): string {
  return `${Math.round(value * 100)}%`;
}
