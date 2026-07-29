import { useMemo } from 'react';
import { createTempCanvas } from '@/lib/irg-parser';
import type { RenderOpts } from '@/lib/irg-parser';
import { formatTimestamp, formatElapsed } from '@/lib/sequence';
import type { SequenceFrame } from '@/lib/sequence';

const btnCls = 'px-2.5 py-1.5 rounded-md font-display text-[0.7rem] font-semibold transition-all text-thermal-muted hover:text-thermal-text hover:bg-white/5';
const btnActiveCls = 'px-2.5 py-1.5 rounded-md font-display text-[0.7rem] font-semibold transition-all bg-thermal-accent text-black shadow-[0_1px_6px] shadow-thermal-accent/30';

function IconPlay() {
  return <svg className="size-3.5" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z" /></svg>;
}
function IconPause() {
  return <svg className="size-3.5" viewBox="0 0 24 24" fill="currentColor"><path d="M6 5h4v14H6zM14 5h4v14h-4z" /></svg>;
}
function IconPrev() {
  return <svg className="size-3.5" viewBox="0 0 24 24" fill="currentColor"><path d="M6 6h2v12H6zM20 6v12l-10-6z" /></svg>;
}
function IconNext() {
  return <svg className="size-3.5" viewBox="0 0 24 24" fill="currentColor"><path d="M16 6h2v12h-2zM4 6v12l10-6z" /></svg>;
}
function IconLoop() {
  return <svg className="size-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round"><path d="M17 2l4 4-4 4" /><path d="M3 11v-1a4 4 0 0 1 4-4h14" /><path d="M7 22l-4-4 4-4" /><path d="M21 13v1a4 4 0 0 1-4 4H3" /></svg>;
}

export function SequencePanel({
  frames, currentIdx, playing, loop, frameMs, globalScale,
  onSeek, onPlayToggle, onLoopToggle, onFrameMs, onGlobalScaleToggle,
  renderOpts,
}: {
  frames: SequenceFrame[];
  currentIdx: number;
  playing: boolean;
  loop: boolean;
  /** Duration each image stays on screen, in ms */
  frameMs: number;
  globalScale: boolean;
  onSeek: (idx: number) => void;
  onPlayToggle: () => void;
  onLoopToggle: () => void;
  onFrameMs: (ms: number) => void;
  onGlobalScaleToggle: () => void;
  /** minC/maxC are the global series range; ignored per-thumbnail when globalScale is off */
  renderOpts: RenderOpts;
}) {
  const current = frames[currentIdx];
  const firstTs = frames[0]?.timestamp ?? null;

  // Small thumbnails: global range → colors comparable across the strip;
  // per-image mode → each thumbnail stretched to its own range
  const thumbs = useMemo(() => frames.map(f => {
    const opts = globalScale
      ? { ...renderOpts, cdfLut: f.image.cdfLut }
      : { ...renderOpts, minC: f.image.dataMin, maxC: f.image.dataMax, cdfLut: f.image.cdfLut };
    const full = createTempCanvas(f.image.celsius, f.image.width, f.image.height, opts);
    const h = 44;
    const w = Math.max(24, Math.round(h * f.image.width / Math.max(1, f.image.height)));
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    const ctx = c.getContext('2d')!;
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(full, 0, 0, w, h);
    return c.toDataURL();
  }), [frames, renderOpts, globalScale]);

  return (
    <div className="bg-thermal-surface/80 rounded-lg px-3 py-2 space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex items-center gap-2">
          <div className="size-1.5 rounded-full bg-thermal-accent shadow-[0_0_6px] shadow-thermal-accent/40" />
          <span className="font-display text-[0.6rem] text-thermal-heading tracking-[0.14em] uppercase">Sequence</span>
        </div>
        <div className="flex rounded-lg bg-black/20 p-0.5">
          <button onClick={() => onSeek(Math.max(0, currentIdx - 1))} title="Previous image" className={btnCls}><IconPrev /></button>
          <button onClick={onPlayToggle} title={playing ? 'Pause' : 'Play'} className={playing ? btnActiveCls : btnCls}>
            {playing ? <IconPause /> : <IconPlay />}
          </button>
          <button onClick={() => onSeek(Math.min(frames.length - 1, currentIdx + 1))} title="Next image" className={btnCls}><IconNext /></button>
          <button onClick={onLoopToggle} title="Loop playback" className={loop ? btnActiveCls : btnCls}><IconLoop /></button>
        </div>
        <div className="flex items-center gap-2">
          <span className="font-display text-[0.55rem] text-thermal-muted uppercase tracking-wider">Speed</span>
          <input type="range" min={500} max={3000} step={250} value={frameMs}
            onChange={e => onFrameMs(parseInt(e.target.value, 10))}
            className="w-24 accent-[var(--color-thermal-accent)]" />
          <span className="font-display text-[0.65rem] text-thermal-text tabular-nums">{(frameMs / 1000).toFixed(2).replace(/0$/, '')}s/img</span>
        </div>
        <div className="w-px h-5 bg-thermal-border" />
        <span className="font-display text-[0.55rem] text-thermal-muted uppercase tracking-wider">Scale</span>
        <div className="flex rounded-lg bg-black/20 p-0.5">
          <button onClick={() => { if (!globalScale) onGlobalScaleToggle(); }}
            title="Lock the color range to the global min/max of the whole series — colors stay comparable between images"
            className={globalScale ? btnActiveCls : btnCls}>
            Global
          </button>
          <button onClick={() => { if (globalScale) onGlobalScaleToggle(); }}
            title="Rescale the color range to each image's own min/max"
            className={!globalScale ? btnActiveCls : btnCls}>
            Per image
          </button>
        </div>
        <div className="flex-1" />
        <span className="font-display text-[0.65rem] text-thermal-text tabular-nums">
          {currentIdx + 1} / {frames.length}
        </span>
        <span className="font-display text-[0.65rem] text-thermal-muted tabular-nums">
          {formatTimestamp(current?.timestamp ?? null)}
          {current?.timestamp != null && firstTs != null && current.timestamp !== firstTs && (
            <span className="ml-1 text-thermal-accent">{formatElapsed(current.timestamp - firstTs)}</span>
          )}
        </span>
      </div>

      <div className="flex gap-1 overflow-x-auto pb-1">
        {frames.map((f, i) => (
          <button key={i} onClick={() => onSeek(i)}
            title={`${f.image.fileName || `#${i + 1}`}\n${formatTimestamp(f.timestamp)}`}
            className={`relative shrink-0 rounded overflow-hidden border transition-all ${i === currentIdx
              ? 'border-thermal-accent shadow-[0_0_8px] shadow-thermal-accent/40'
              : 'border-thermal-border opacity-60 hover:opacity-100'}`}>
            <img src={thumbs[i]} alt={f.image.fileName || `frame ${i + 1}`} className="block h-11" draggable={false} />
            <span className="absolute bottom-0 left-0 right-0 bg-black/60 font-display text-[0.5rem] text-white text-center tabular-nums leading-tight">
              {i + 1}
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}
