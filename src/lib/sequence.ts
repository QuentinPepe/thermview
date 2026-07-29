import type { ThermalImage } from '@/lib/types';

/** One image of a time-series, with pre-computed stats used by the sequence UI. */
export interface SequenceFrame {
  image: ThermalImage;
  /** Epoch ms — EXIF capture date when available, else file mtime, else null */
  timestamp: number | null;
  /** Mean temperature (°C) over all pixels */
  mean: number;
}

/** Best-effort capture timestamp: EXIF DateTimeOriginal, then file mtime. */
export function frameTimestamp(img: ThermalImage): number | null {
  const cd = img.captureDate as unknown;
  if (cd instanceof Date) {
    const t = cd.getTime();
    if (!Number.isNaN(t)) return t;
  } else if (typeof cd === 'string' && cd) {
    // EXIF dates carry no timezone; treat as UTC like the single-image path
    let t = new Date(cd + 'Z').getTime();
    if (Number.isNaN(t)) t = new Date(cd).getTime();
    if (!Number.isNaN(t)) return t;
  }
  return img.fileModified ?? null;
}

export function meanTemp(img: ThermalImage): number {
  const a = img.celsius;
  if (!a.length) return 0;
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += a[i];
  return sum / a.length;
}

/**
 * Order parsed images into a playable sequence.
 * Sorted by timestamp when every image has one, otherwise by file name
 * (numeric-aware, so img_2 < img_10).
 */
export function buildSequence(images: ThermalImage[]): SequenceFrame[] {
  const frames = images.map(image => ({
    image,
    timestamp: frameTimestamp(image),
    mean: meanTemp(image),
  }));
  const allTimed = frames.length > 0 && frames.every(f => f.timestamp !== null);
  if (allTimed) {
    frames.sort((a, b) => (a.timestamp! - b.timestamp!) ||
      a.image.fileName.localeCompare(b.image.fileName, undefined, { numeric: true }));
  } else {
    frames.sort((a, b) =>
      a.image.fileName.localeCompare(b.image.fileName, undefined, { numeric: true }));
  }
  return frames;
}

export function formatTimestamp(ts: number | null): string {
  if (ts === null) return '—';
  return new Date(ts).toLocaleString(undefined, {
    year: 'numeric', month: 'short', day: 'numeric',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
}

/** "+2m30s" / "+3h05m" / "+2d4h" style elapsed-time label relative to the first frame. */
export function formatElapsed(ms: number): string {
  const s = Math.round(ms / 1000);
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  const rem = s % 60;
  if (d > 0) return `+${d}d${h}h`;
  if (h > 0) return `+${h}h${m.toString().padStart(2, '0')}m`;
  if (m > 0) return `+${m}m${rem.toString().padStart(2, '0')}s`;
  return `+${rem}s`;
}
