import { useRef, useState, useEffect, useMemo, useCallback } from 'react';
import { toUnit, tickStep } from '@/lib/units';
import { formatElapsed } from '@/lib/sequence';
import type { SequenceFrame } from '@/lib/sequence';
import type { TempUnit } from '@/lib/types';

const COLOR_MIN = '#3b82f6';
const COLOR_MEAN = '#0d9488';
const COLOR_MAX = '#ef4444';

const CHART_H = 220;
const PAD = { top: 14, right: 52, bottom: 24, left: 46 };
const FONT = '10px "JetBrains Mono", "Fira Code", monospace';

interface Series { key: 'max' | 'mean' | 'min'; label: string; color: string; dashed: boolean; get: (f: SequenceFrame) => number }
const SERIES: Series[] = [
  { key: 'max', label: 'Max', color: COLOR_MAX, dashed: false, get: f => f.image.dataMax },
  { key: 'mean', label: 'Mean', color: COLOR_MEAN, dashed: true, get: f => f.mean },
  { key: 'min', label: 'Min', color: COLOR_MIN, dashed: false, get: f => f.image.dataMin },
];

/** Min / mean / max evolution over the sequence, drawn on a plain 2D canvas. */
export function SequenceChart({ frames, currentIdx, tempUnit, onSeek }: {
  frames: SequenceFrame[];
  currentIdx: number;
  tempUnit: TempUnit;
  onSeek: (idx: number) => void;
}) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [width, setWidth] = useState(600);
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);

  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setWidth(Math.max(280, el.clientWidth)));
    ro.observe(el);
    setWidth(Math.max(280, el.clientWidth));
    return () => ro.disconnect();
  }, []);

  // X positions: proportional to timestamps when every frame has one, else evenly spaced
  const allTimed = frames.every(f => f.timestamp !== null);
  const xFracs = useMemo(() => {
    const n = frames.length;
    if (n < 2) return frames.map(() => 0.5);
    if (allTimed) {
      const t0 = frames[0].timestamp!;
      const span = frames[n - 1].timestamp! - t0;
      if (span > 0) return frames.map(f => (f.timestamp! - t0) / span);
    }
    return frames.map((_, i) => i / (n - 1));
  }, [frames, allTimed]);

  const [yMin, yMax] = useMemo(() => {
    let lo = Infinity, hi = -Infinity;
    for (const f of frames) {
      if (f.image.dataMin < lo) lo = f.image.dataMin;
      if (f.image.dataMax > hi) hi = f.image.dataMax;
    }
    if (!Number.isFinite(lo)) { lo = 0; hi = 1; }
    const pad = Math.max(0.5, (hi - lo) * 0.08);
    return [lo - pad, hi + pad];
  }, [frames]);

  const plotW = width - PAD.left - PAD.right;
  const plotH = CHART_H - PAD.top - PAD.bottom;
  const xPos = useCallback((i: number) => PAD.left + xFracs[i] * plotW, [xFracs, plotW]);
  const yPos = useCallback((c: number) => PAD.top + (1 - (c - yMin) / (yMax - yMin)) * plotH, [yMin, yMax, plotH]);

  useEffect(() => {
    const cvs = canvasRef.current;
    if (!cvs || frames.length === 0) return;
    const dpr = window.devicePixelRatio || 1;
    cvs.width = width * dpr;
    cvs.height = CHART_H * dpr;
    cvs.style.width = `${width}px`;
    cvs.style.height = `${CHART_H}px`;
    const ctx = cvs.getContext('2d')!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, CHART_H);

    // --- Recessive grid + y labels ---
    ctx.font = FONT;
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    const span = yMax - yMin;
    const step = tickStep(span, 8);
    for (let v = Math.ceil(yMin / step) * step; v <= yMax; v += step) {
      const y = yPos(v);
      ctx.strokeStyle = 'rgba(255,255,255,0.07)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(PAD.left, y);
      ctx.lineTo(width - PAD.right, y);
      ctx.stroke();
      ctx.fillStyle = 'rgba(255,255,255,0.45)';
      ctx.fillText(`${toUnit(v, tempUnit)}°`, PAD.left - 6, y);
    }

    // --- X labels: elapsed time (or image index) at first / middle / last ---
    // Drop the middle label when uneven spacing pushes it against an edge label
    ctx.textBaseline = 'top';
    const midIdx = Math.floor((frames.length - 1) / 2);
    const midClear = xPos(midIdx) - xPos(0) > 70 && xPos(frames.length - 1) - xPos(midIdx) > 70;
    const labelIdxs = frames.length > 2
      ? (midClear ? [0, midIdx, frames.length - 1] : [0, frames.length - 1])
      : frames.map((_, i) => i);
    const t0 = frames[0].timestamp;
    for (const i of labelIdxs) {
      const lbl = allTimed && t0 !== null
        ? (i === 0 ? new Date(t0).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' })
          : formatElapsed(frames[i].timestamp! - t0))
        : `#${i + 1}`;
      ctx.textAlign = i === 0 ? 'left' : i === frames.length - 1 ? 'right' : 'center';
      ctx.fillStyle = 'rgba(255,255,255,0.45)';
      ctx.fillText(lbl, xPos(i), CHART_H - PAD.bottom + 8);
    }

    // --- Current-frame marker ---
    if (frames.length > 1) {
      const cx = xPos(currentIdx);
      ctx.strokeStyle = 'rgba(249,115,22,0.55)';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(cx, PAD.top);
      ctx.lineTo(cx, CHART_H - PAD.bottom);
      ctx.stroke();
    }

    // --- Hover crosshair ---
    if (hoverIdx !== null && hoverIdx !== currentIdx) {
      const hx = xPos(hoverIdx);
      ctx.strokeStyle = 'rgba(255,255,255,0.25)';
      ctx.lineWidth = 1;
      ctx.setLineDash([3, 3]);
      ctx.beginPath();
      ctx.moveTo(hx, PAD.top);
      ctx.lineTo(hx, CHART_H - PAD.bottom);
      ctx.stroke();
      ctx.setLineDash([]);
    }

    // --- Series lines + markers + direct end labels ---
    for (const s of SERIES) {
      ctx.strokeStyle = s.color;
      ctx.lineWidth = 2;
      ctx.setLineDash(s.dashed ? [5, 4] : []);
      ctx.beginPath();
      frames.forEach((f, i) => {
        const x = xPos(i), y = yPos(s.get(f));
        if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      });
      ctx.stroke();
      ctx.setLineDash([]);

      ctx.fillStyle = s.color;
      frames.forEach((f, i) => {
        const r = i === currentIdx || i === hoverIdx ? 4 : 2.5;
        ctx.beginPath();
        ctx.arc(xPos(i), yPos(s.get(f)), r, 0, Math.PI * 2);
        ctx.fill();
      });

      const last = frames[frames.length - 1];
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      ctx.font = `bold ${FONT}`;
      ctx.fillText(s.label, width - PAD.right + 6, yPos(s.get(last)));
    }
  }, [frames, width, currentIdx, hoverIdx, tempUnit, allTimed, xPos, yPos, yMin, yMax]);

  const nearestIdx = useCallback((clientX: number) => {
    const cvs = canvasRef.current;
    if (!cvs || frames.length === 0) return null;
    const x = clientX - cvs.getBoundingClientRect().left;
    let best = 0, bestD = Infinity;
    for (let i = 0; i < frames.length; i++) {
      const d = Math.abs(x - xPos(i));
      if (d < bestD) { bestD = d; best = i; }
    }
    return best;
  }, [frames.length, xPos]);

  if (frames.length < 2) return null;

  const hovered = hoverIdx !== null ? frames[hoverIdx] : null;

  return (
    <div className="bg-thermal-surface/80 rounded-lg px-4 py-3">
      <div className="flex items-center gap-2 mb-2">
        <div className="size-1.5 rounded-full bg-thermal-accent shadow-[0_0_6px] shadow-thermal-accent/40" />
        <span className="font-display text-[0.6rem] text-thermal-heading tracking-[0.14em] uppercase">Temperature over time</span>
        <div className="flex-1" />
        {SERIES.map(s => (
          <span key={s.key} className="flex items-center gap-1.5 font-display text-[0.6rem] text-thermal-text">
            <span className="inline-block w-4 border-t-2" style={{ borderColor: s.color, borderTopStyle: s.dashed ? 'dashed' : 'solid' }} />
            {s.label}
          </span>
        ))}
      </div>
      <div ref={wrapRef} className="relative">
        <canvas
          ref={canvasRef}
          className="block cursor-pointer"
          onMouseMove={e => setHoverIdx(nearestIdx(e.clientX))}
          onMouseLeave={() => setHoverIdx(null)}
          onClick={e => { const i = nearestIdx(e.clientX); if (i !== null) onSeek(i); }}
        />
        {hovered && hoverIdx !== null && (
          <div className="absolute pointer-events-none bg-black/85 backdrop-blur-sm border border-white/10 rounded px-2 py-1.5 font-display text-[0.65rem] z-10 space-y-0.5"
            style={{
              left: `${Math.min(Math.max(0, xPos(hoverIdx) + 10), width - 130)}px`,
              top: '6px',
            }}>
            <div className="text-thermal-muted">{hovered.image.fileName || `#${hoverIdx + 1}`}</div>
            <div style={{ color: COLOR_MAX }}>Max&nbsp;&nbsp;{toUnit(hovered.image.dataMax, tempUnit)}°{tempUnit}</div>
            <div style={{ color: COLOR_MEAN }}>Mean&nbsp;{toUnit(hovered.mean, tempUnit)}°{tempUnit}</div>
            <div style={{ color: COLOR_MIN }}>Min&nbsp;&nbsp;{toUnit(hovered.image.dataMin, tempUnit)}°{tempUnit}</div>
          </div>
        )}
      </div>
    </div>
  );
}
