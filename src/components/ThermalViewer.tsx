import { useState, useRef, useCallback, useMemo, useEffect } from 'react';
import { parseThermalImages } from '@/lib/format-detector';
import type { RenderOpts } from '@/lib/irg-parser';
import { recomputeThermalImage } from '@/lib/calibration';
import { CURSOR_COLORS, PALETTES, OVERSCAN_OPTIONS } from '@/lib/constants';
import { toUnit } from '@/lib/units';
import type { MeasurementCursor, OverlayConfig, FileInfo, TempUnit, Overscan, ScaleMode, Palette, ThermalImage } from '@/lib/types';
import { extractExifMeta } from '@/lib/types';
import { measureDjiWithSdk } from '@/lib/dji-sdk';
import { buildSequence, meanTemp } from '@/lib/sequence';
import type { SequenceFrame } from '@/lib/sequence';
import { ThermalCanvas } from '@/components/ThermalCanvas';
import { RangeColorBar } from '@/components/RangeColorBar';
import { CursorPanel } from '@/components/CursorPanel';
import { UpdateBanner } from '@/components/UpdateBanner';
import { SequencePanel } from '@/components/SequencePanel';
import { SequenceChart } from '@/components/SequenceChart';
import { SequenceStats } from '@/components/SequenceStats';

function StatPill({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col px-4 py-2.5 bg-thermal-surface/60">
      <span className="text-[0.6rem] tracking-[0.14em] uppercase text-thermal-muted font-display">{label}</span>
      <span className="font-display text-sm text-thermal-heading tabular-nums mt-0.5">{value}</span>
    </div>
  );
}

interface CalibrationEditorProps {
  emissivity: number;
  distance: number;
  refTemp: number;
  airTemp: number;
  humidity: number;
  tempUnit: TempUnit;
  onEmissivity: (v: number) => void;
  onDistance: (v: number) => void;
  onRefTemp: (v: number) => void;
  onAirTemp: (v: number) => void;
  onHumidity: (v: number) => void;
}

function CalibrationEditor(p: CalibrationEditorProps) {
  const inputCls = 'w-full px-2 py-1.5 bg-black/30 border border-thermal-border rounded-md font-display text-xs text-thermal-heading tabular-nums focus:outline-none focus:border-thermal-accent/50 focus:ring-1 focus:ring-thermal-accent/30 transition-colors';
  const labelCls = 'font-display text-[0.55rem] text-thermal-muted uppercase tracking-wider';
  const dimLabel = 'ml-2 text-[0.55rem] text-thermal-muted font-display';

  return (
    <div className="bg-thermal-surface/80 rounded-lg px-4 py-3">
      <div className="flex items-center gap-2 mb-3">
        <div className="size-1.5 rounded-full bg-thermal-accent shadow-[0_0_6px] shadow-thermal-accent/40" />
        <span className="font-display text-[0.6rem] text-thermal-heading tracking-[0.14em] uppercase">Calibration</span>
        <span className="font-display text-[0.55rem] text-thermal-muted">edit parameters to recompute temperatures</span>
      </div>
      <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-5 gap-3">
        <div>
          <div className={labelCls}>Emissivity</div>
          <input type="number" className={inputCls} min={0.01} max={1} step={0.01}
            value={p.emissivity} onChange={e => p.onEmissivity(parseFloat(e.target.value) || 0.95)} />
          <div className={dimLabel}>ε: 0.01–1.00</div>
        </div>
        <div>
          <div className={labelCls}>Distance</div>
          <input type="number" className={inputCls} min={0.1} max={100} step={0.1}
            value={p.distance} onChange={e => p.onDistance(parseFloat(e.target.value) || 1)} />
          <div className={dimLabel}>metres</div>
        </div>
        <div>
          <div className={labelCls}>Reflected Temp</div>
          <input type="number" className={inputCls} min={-50} max={200} step={0.1}
            value={p.refTemp} onChange={e => p.onRefTemp(parseFloat(e.target.value) || 20)} />
          <div className={dimLabel}>°{p.tempUnit}</div>
        </div>
        <div>
          <div className={labelCls}>Atmosphere Temp</div>
          <input type="number" className={inputCls} min={-50} max={80} step={0.1}
            value={p.airTemp} onChange={e => p.onAirTemp(parseFloat(e.target.value) || 20)} />
          <div className={dimLabel}>°{p.tempUnit}</div>
        </div>
        <div>
          <div className={labelCls}>Humidity</div>
          <input type="number" className={inputCls} min={0} max={100} step={1}
            value={p.humidity} onChange={e => p.onHumidity(parseFloat(e.target.value) || 50)} />
          <div className={dimLabel}>% RH (0–100)</div>
        </div>
      </div>
    </div>
  );
}

export function ThermalViewer() {
  const [rawFrames, setRawFrames] = useState<SequenceFrame[]>([]);
  const [currentIdx, setCurrentIdx] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [loop, setLoop] = useState(true);
  const [frameMs, setFrameMs] = useState(1000);
  const [globalScale, setGlobalScale] = useState(true);
  const [palette, setPalette] = useState<Palette>('inferno');
  const [tempUnit, setTempUnit] = useState<TempUnit>('C');
  const [scaleMode, setScaleMode] = useState<ScaleMode>('linear');
  const [rangeMin, setRangeMin] = useState(0);
  const [rangeMax, setRangeMax] = useState(0);
  const [overscan, setOverscan] = useState<Overscan>('clip');
  /** Zoom factor, or 'fit' to size the image to the available width */
  const [scale, setScale] = useState<number | 'fit'>('fit');
  const [inverted, setInverted] = useState(false);
  const [labelScale, setLabelScale] = useState(10);
  const [hoverTemp, setHoverTemp] = useState<number | null>(null);
  const [cursors, setCursors] = useState<MeasurementCursor[]>([]);
  const [overlay, setOverlay] = useState<OverlayConfig>({ showMinMaxSpots: true, showEmissivity: true, showTimestamp: true });

  // Editable calibration params (initialised from file defaults)
  const [editEmissivity, setEditEmissivity] = useState(0.95);
  const [editDistance, setEditDistance] = useState(1);
  const [editRefTemp, setEditRefTemp] = useState(20);
  const [editAirTemp, setEditAirTemp] = useState(20);
  const [editHumidity, setEditHumidity] = useState(50);

  const cursorIdRef = useRef(0);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const exportCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const [rootWidth, setRootWidth] = useState(1200);

  useEffect(() => {
    const el = rootRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setRootWidth(el.clientWidth));
    ro.observe(el);
    setRootWidth(el.clientWidth);
    return () => ro.disconnect();
  }, []);

  // Apply calibration edits to every frame; skipped when params match the file
  // defaults or the format is not recomputable, so this is free in the common case
  const frames = useMemo(() => rawFrames.map(f => {
    const img = f.image;
    const unchanged =
      Math.abs(editEmissivity - img.emissivity) < 1e-6 &&
      Math.abs(editDistance - img.distance) < 1e-6 &&
      Math.abs(editRefTemp - img.refTemp) < 1e-6 &&
      Math.abs(editAirTemp - img.airTemp) < 1e-6 &&
      Math.abs(editHumidity - img.humidity) < 1e-6;
    if (unchanged || !img.isRecomputable) return f;
    const re = recomputeThermalImage(img, {
      emissivity: editEmissivity,
      distance: editDistance,
      refTemp: editRefTemp,
      airTemp: editAirTemp,
      humidity: editHumidity,
    });
    return { ...f, image: re, mean: meanTemp(re) };
  }), [rawFrames, editEmissivity, editDistance, editRefTemp, editAirTemp, editHumidity]);

  const isSequence = frames.length > 1;
  const activeFrame = frames[currentIdx] ?? null;
  const activeImage = activeFrame?.image ?? null;

  // Global min/max over the whole series — the comparable-colors lock
  const globalRange = useMemo(() => {
    let lo = Infinity, hi = -Infinity;
    for (const f of frames) {
      if (f.image.dataMin < lo) lo = f.image.dataMin;
      if (f.image.dataMax > hi) hi = f.image.dataMax;
    }
    return Number.isFinite(lo) ? { min: lo, max: hi } : null;
  }, [frames]);

  const lockScale = globalScale && isSequence && globalRange !== null;
  const barMin = lockScale ? globalRange!.min : activeImage?.dataMin ?? 0;
  const barMax = lockScale ? globalRange!.max : activeImage?.dataMax ?? 0;

  const fileInfo: FileInfo = useMemo(() => activeFrame
    ? { name: activeFrame.image.fileName, modified: activeFrame.timestamp }
    : { name: '', modified: null }, [activeFrame]);

  const renderOpts: RenderOpts = useMemo(() => ({
    palette, minC: rangeMin, maxC: rangeMax, overscan, scaleMode,
    belowColor: [0, 0, 128] as [number, number, number],
    aboveColor: [255, 255, 255] as [number, number, number],
    inverted,
    cdfLut: activeImage?.cdfLut ?? undefined,
  }), [palette, rangeMin, rangeMax, overscan, scaleMode, inverted, activeImage?.cdfLut]);

  // Thumbnail render opts: pinned to the global range so timeline strips stay
  // stable while the user drags the range handles
  const thumbOpts: RenderOpts = useMemo(() => ({
    palette, minC: globalRange?.min ?? 0, maxC: globalRange?.max ?? 1, overscan, scaleMode,
    belowColor: [0, 0, 128] as [number, number, number],
    aboveColor: [255, 255, 255] as [number, number, number],
    inverted,
  }), [palette, globalRange, overscan, scaleMode, inverted]);

  // Cursors follow the sequence: same pixel, re-sampled on the current image
  const displayCursors = useMemo(() => {
    if (!activeImage) return cursors;
    return cursors.map(c => {
      if (c.x < 0 || c.y < 0 || c.x >= activeImage.width || c.y >= activeImage.height) return c;
      return { ...c, tempC: activeImage.celsius[c.y * activeImage.width + c.x] };
    });
  }, [cursors, activeImage]);

  const processFiles = useCallback(async (files: File[]) => {
    if (!files.length) return;
    const errors: string[] = [];
    const images: ThermalImage[] = [];
    await Promise.all(files.map(async f => {
      const buf = await f.arrayBuffer();
      let imgs: ThermalImage[];
      try {
        // A file may hold several frames (.seq thermal video) — flatten them all
        imgs = parseThermalImages(buf, f.name, f.lastModified);
      } catch (err) {
        // Newer DJI cameras are rejected by the JS parser on purpose. In the
        // desktop build, DJI's own SDK can still measure them exactly.
        let viaSdk: ThermalImage | null;
        try {
          viaSdk = await measureDjiWithSdk(buf, f.name, f.lastModified);
        } catch (sdkErr) {
          // The SDK was there and refused the file: say why, since that is the
          // real reason, not the parser's "unsupported camera" message.
          errors.push(`${f.name}: DJI SDK could not read this file — ${sdkErr}`);
          return;
        }
        if (!viaSdk) { errors.push(`${f.name}: ${(err as Error).message}`); return; }
        imgs = [viaSdk];
      }
      // EXIF is awaited up-front here: capture dates are needed to sort the sequence
      const meta = await extractExifMeta(buf);
      if (meta) {
        for (const img of imgs) {
          img.cameraInfo = meta.cameraInfo;
          img.captureDate = meta.captureDate;
        }
      }
      images.push(...imgs);
    }));
    if (errors.length) alert(`Failed to parse ${errors.length} file(s):\n${errors.join('\n')}`);
    if (!images.length) return;

    const seq = buildSequence(images);
    setRawFrames(seq);
    setCurrentIdx(0);
    setPlaying(false);
    setCursors([]);
    setGlobalScale(true);

    // Lock the range to the global series min/max so colors are comparable
    let lo = Infinity, hi = -Infinity;
    for (const fr of seq) {
      lo = Math.min(lo, fr.image.dataMin);
      hi = Math.max(hi, fr.image.dataMax);
    }
    setRangeMin(lo);
    setRangeMax(hi);

    const first = seq[0].image;
    setEditEmissivity(first.emissivity);
    setEditDistance(first.distance);
    setEditRefTemp(first.refTemp);
    setEditAirTemp(first.airTemp);
    setEditHumidity(first.humidity);
  }, []);

  const upload = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    processFiles(Array.from(e.target.files ?? []));
  }, [processFiles]);

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    processFiles(Array.from(e.dataTransfer.files ?? []));
  }, [processFiles]);

  // Jump to an image; in per-image scale mode, re-range to that image's min/max
  const seek = useCallback((idx: number) => {
    const clamped = Math.max(0, Math.min(frames.length - 1, idx));
    setCurrentIdx(clamped);
    if (!globalScale && frames.length > 1) {
      const img = frames[clamped]?.image;
      if (img) {
        setRangeMin(img.dataMin);
        setRangeMax(img.dataMax);
      }
    }
  }, [frames, globalScale]);

  // Playback: advance on an interval; stop at the end unless looping.
  // The tick handler lives in a ref so the interval isn't reset on every seek.
  const advanceRef = useRef<() => void>(() => {});
  useEffect(() => {
    advanceRef.current = () => {
      const next = currentIdx + 1;
      if (next < frames.length) seek(next);
      else if (loop) seek(0);
      else setPlaying(false);
    };
  });
  useEffect(() => {
    if (!playing || frames.length < 2) return;
    const id = setInterval(() => advanceRef.current(), frameMs);
    return () => clearInterval(id);
  }, [playing, frames.length, frameMs]);

  const toggleGlobalScale = useCallback(() => {
    setGlobalScale(g => {
      const next = !g;
      if (next && globalRange) {
        setRangeMin(globalRange.min);
        setRangeMax(globalRange.max);
      } else if (activeImage) {
        setRangeMin(activeImage.dataMin);
        setRangeMax(activeImage.dataMax);
      }
      return next;
    });
  }, [globalRange, activeImage]);

  const addCursor = useCallback((x: number, y: number, tempC: number) => {
    const id = ++cursorIdRef.current;
    const colorIdx = cursors.length % CURSOR_COLORS.length;
    setCursors(prev => [...prev, { id, x, y, label: `${id}`, colorIdx, tempC }]);
  }, [cursors.length]);

  const removeCursor = useCallback((id: number) => setCursors(prev => prev.filter(c => c.id !== id)), []);
  const renameCursor = useCallback((id: number, label: string) =>
    setCursors(prev => prev.map(c => c.id === id ? { ...c, label } : c)), []);

  const clear = useCallback(() => {
    setRawFrames([]);
    setCurrentIdx(0);
    setPlaying(false);
    setCursors([]);
    setOverlay({ showMinMaxSpots: true, showEmissivity: true, showTimestamp: true });
    if (fileInputRef.current) fileInputRef.current.value = '';
  }, []);

  const autoRange = () => {
    if (lockScale) {
      setRangeMin(globalRange!.min);
      setRangeMax(globalRange!.max);
    } else if (activeImage) {
      setRangeMin(activeImage.dataMin);
      setRangeMax(activeImage.dataMax);
    }
  };
  const range20_40 = () => { setRangeMin(20); setRangeMax(40); };
  const range0_80 = () => { setRangeMin(0); setRangeMax(80); };
  const rangeNeg10_50 = () => { setRangeMin(-10); setRangeMax(50); };

  // 'fit' sizes the image to the width left over by the color bar and cursor
  // panel, so a 640x512 sensor doesn't overflow the viewport at 3x.
  const SIDE_PANELS = 400;
  const fitScale = useMemo(() => {
    if (!activeImage) return 1;
    const avail = Math.max(240, rootWidth - SIDE_PANELS);
    return Math.max(0.5, Math.min(6, avail / activeImage.width));
  }, [activeImage, rootWidth]);

  const effectiveScale = activeImage ? (scale === 'fit' ? fitScale : scale) : 1;
  const displayH = activeImage ? activeImage.height * effectiveScale : 0;

  const download = useCallback(() => {
    const cvs = exportCanvasRef.current; if (!cvs) return;
    const a = document.createElement('a');
    a.download = 'thermal-image.png';
    a.href = cvs.toDataURL('image/png');
    a.click();
  }, []);

  return (
    <div ref={rootRef} className="py-4 space-y-4">
      <header className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="size-2.5 rounded-full bg-thermal-hot shadow-[0_0_10px] shadow-thermal-hot/50 animate-pulse" />
          <h1 className="font-display text-base tracking-tight text-thermal-heading">THERMVIEW</h1>
        </div>
        <div className="flex items-center gap-3">
          <a href="https://github.com/v0l/thermview" target="_blank" rel="noopener noreferrer" className="flex items-center gap-2 px-3 py-1.5 rounded-md bg-thermal-surface/60 hover:bg-thermal-surface transition-colors group" title="View on GitHub">
            <svg className="size-4 text-thermal-muted group-hover:text-thermal-text transition-colors" fill="currentColor" viewBox="0 0 24 24"><path d="M12 0C5.37 0 0 5.37 0 12c0 5.31 3.435 9.795 8.205 11.385.6.105.825-.255.825-.57 0-.285-.015-1.23-.015-2.235-3.015.555-3.795-.735-4.035-1.41-.135-.345-.72-1.41-1.23-1.695-.42-.225-1.02-.78-.015-.795.945-.015 1.62.87 1.845 1.23 1.08 1.815 2.805 1.305 3.495.99.105-.78.42-1.305.765-1.605-2.67-.3-5.46-1.335-5.46-5.925 0-1.305.465-2.385 1.23-3.225-.12-.3-.54-1.53.12-3.18 0 0 1.005-.315 3.3 1.23.96-.27 1.98-.405 3-.405s2.04.135 3 .405c2.295-1.56 3.3-1.23 3.3-1.23.66 1.65.24 2.88.12 3.18.765.84 1.23 1.905 1.23 3.225 0 4.605-2.805 5.625-5.475 5.925.435.375.81 1.095.81 2.22 0 1.605-.015 2.895-.015 3.3 0 .315.225.69.825.57C20.565 21.795 24 17.31 24 12c0-6.63-5.37-12-12-12z"/></svg>
            <span className="font-display text-[0.65rem] text-thermal-muted group-hover:text-thermal-text transition-colors">GitHub</span>
          </a>
          <span className="font-display text-[0.65rem] text-thermal-muted tracking-[0.2em]">MULTI-FORMAT THERMAL ANALYZER</span>
        </div>
      </header>

      <UpdateBanner />

      {!activeImage ? (
        <div onDragOver={e => e.preventDefault()} onDrop={handleDrop} onClick={() => fileInputRef.current?.click()}
          className="relative group cursor-pointer border-2 border-dashed border-thermal-border rounded-2xl p-12 flex flex-col items-center gap-4 hover:border-thermal-accent/40 transition-colors duration-300">
          <input ref={fileInputRef} type="file" accept=".irg,.jpg,.jpeg,.img,.seq,.fff" multiple onChange={upload} className="hidden" />
          <div className="size-16 rounded-2xl bg-thermal-surface flex items-center justify-center group-hover:bg-thermal-accent/10 transition-colors">
            <svg className="size-7 text-thermal-muted group-hover:text-thermal-accent transition-colors" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M3 16.5v2.25A2.25 2.25 0 0 0 5.25 21h13.5A2.25 2.25 0 0 0 21 18.75V16.5m-13.5-9L12 3m0 0 4.5 4.5M12 3v13.5" />
            </svg>
          </div>
          <p className="font-display text-sm text-thermal-heading">Drop thermal image(s) here</p>
          <p className="text-xs text-thermal-muted mt-1">IRG, Hikmicro, DJI, FLIR R-JPEG, FLIR .img / .seq video — drag or click to browse</p>
          <p className="text-xs text-thermal-muted">Drop several images taken over time — or one .seq recording — to analyze a temperature sequence</p>
        </div>
      ) : (
        <>
          <div className="space-y-3">
            <div className="flex flex-wrap items-center gap-2">
              <div className="flex flex-wrap gap-1 bg-thermal-surface rounded-lg p-1">
                {PALETTES.map(p => (
                  <button key={p.value} onClick={() => setPalette(p.value)}
                    className={`px-2.5 py-1.5 rounded-md font-display text-[0.7rem] font-semibold tracking-wide transition-all ${palette === p.value ? 'bg-thermal-accent text-black shadow-[0_1px_6px] shadow-thermal-accent/30' : 'text-thermal-muted hover:text-thermal-text'}`}>
                    {p.label}
                  </button>
                ))}
              </div>
              <div className="w-px h-6 bg-thermal-border" />
              <span className="font-display text-[0.55rem] text-thermal-muted uppercase tracking-wider">Unit</span>
              <div className="flex rounded-lg bg-thermal-surface p-0.5">
                {(['C','F'] as TempUnit[]).map(u => (
                  <button key={u} onClick={() => setTempUnit(u)}
                    className={`px-2.5 py-1.5 rounded-md font-display text-[0.7rem] font-semibold transition-all ${tempUnit === u ? 'bg-thermal-accent text-black shadow-[0_1px_6px] shadow-thermal-accent/30' : 'text-thermal-muted hover:text-thermal-text'}`}>
                    °{u}
                  </button>
                ))}
              </div>
              <div className="flex-1" />
              <span className="font-display text-[0.55rem] text-thermal-muted uppercase tracking-wider">Scale</span>
              <div className="flex items-center gap-1 bg-thermal-surface rounded-lg p-0.5">
                <button onClick={() => setScale('fit')}
                  title={`Fit the image to the window (currently ${fitScale.toFixed(1)}×)`}
                  className={`px-2.5 py-1.5 rounded-md font-display text-[0.7rem] font-semibold transition-all ${scale === 'fit' ? 'bg-thermal-accent text-black' : 'text-thermal-muted hover:text-thermal-text'}`}>
                  Fit
                </button>
                {[1,2,3,4,5,6].map(s => (
                  <button key={s} onClick={() => setScale(s)}
                    className={`px-2.5 py-1.5 rounded-md font-display text-[0.7rem] font-semibold transition-all ${scale === s ? 'bg-thermal-accent text-black' : 'text-thermal-muted hover:text-thermal-text'}`}>
                    {s}×
                  </button>
                ))}
              </div>
              <div className="flex rounded-lg bg-black/20 p-0.5">
                <button onClick={download}
                  className="px-2.5 py-1.5 rounded-md font-display text-[0.7rem] font-semibold transition-all text-thermal-heading hover:text-thermal-text hover:bg-white/5">
                  Export
                </button>
                <button onClick={clear}
                  className="px-2.5 py-1.5 rounded-md font-display text-[0.7rem] font-semibold transition-all text-thermal-muted hover:text-thermal-text hover:bg-white/5">
                  Clear
                </button>
              </div>
            </div>

            <div className="flex flex-wrap items-center gap-2 bg-thermal-surface rounded-lg px-3 py-2">
              <span className="font-display text-[0.65rem] text-thermal-muted uppercase tracking-wider">Range</span>
              <div className="flex rounded-lg bg-black/20 p-0.5">
                <button onClick={autoRange}
                  className="px-2.5 py-1.5 rounded-md font-display text-[0.7rem] font-semibold transition-all text-thermal-accent hover:text-thermal-heading hover:bg-white/5">
                  Auto
                </button>
                <button onClick={range20_40}
                  className="px-2.5 py-1.5 rounded-md font-display text-[0.7rem] font-semibold transition-all text-thermal-muted hover:text-thermal-text hover:bg-white/5">
                  20–40°{tempUnit}
                </button>
                <button onClick={range0_80}
                  className="px-2.5 py-1.5 rounded-md font-display text-[0.7rem] font-semibold transition-all text-thermal-muted hover:text-thermal-text hover:bg-white/5">
                  0–80°{tempUnit}
                </button>
                <button onClick={rangeNeg10_50}
                  className="px-2.5 py-1.5 rounded-md font-display text-[0.7rem] font-semibold transition-all text-thermal-muted hover:text-thermal-text hover:bg-white/5">
                  −10–50°{tempUnit}
                </button>
              </div>
              <div className="w-px h-5 bg-thermal-border" />
              <span className="font-display text-[0.55rem] text-thermal-muted uppercase tracking-wider">Overscan</span>
              <div className="flex rounded-lg bg-black/20 p-0.5">
                {OVERSCAN_OPTIONS.map(o => (
                  <button key={o.value} onClick={() => setOverscan(o.value)}
                    title={o.value === 'clip' ? 'Clamp to palette edge' : o.value === 'none' ? 'Hide out-of-range' : o.value === 'below' ? 'Below-range as blue' : 'Above-range as white'}
                    className={`px-2.5 py-1.5 rounded-md font-display text-[0.7rem] font-semibold transition-all ${overscan === o.value ? 'bg-thermal-accent text-black shadow-[0_1px_6px] shadow-thermal-accent/30' : 'text-thermal-muted hover:text-thermal-text'}`}>
                    {o.label}
                  </button>
                ))}
              </div>
              <div className="w-px h-5 bg-thermal-border" />
              <span className="font-display text-[0.55rem] text-thermal-muted uppercase tracking-wider">Mapping</span>
              <div className="flex rounded-lg bg-black/20 p-0.5">
                {(['linear','log','equalize'] as ScaleMode[]).map(m => (
                  <button key={m} onClick={() => setScaleMode(m)}
                    title={m === 'linear' ? 'Uniform color spread' : m === 'log' ? 'More detail at cold end' : 'Percentile stretch (full palette)'}
                    className={`px-2.5 py-1.5 rounded-md font-display text-[0.7rem] font-semibold transition-all capitalize ${scaleMode === m ? 'bg-thermal-accent text-black shadow-[0_1px_6px] shadow-thermal-accent/30' : 'text-thermal-muted hover:text-thermal-text'}`}>
                    {m === 'equalize' ? 'Eq' : m}
                  </button>
                ))}
              </div>
              <div className="w-px h-5 bg-thermal-border" />
              <span className="font-display text-[0.55rem] text-thermal-muted uppercase tracking-wider">Invert</span>
              <button onClick={() => setInverted(i => !i)}
                className={`px-2.5 py-1.5 rounded-md font-display text-[0.7rem] font-semibold transition-all ${inverted ? 'bg-thermal-accent text-black shadow-[0_1px_6px] shadow-thermal-accent/30' : 'text-thermal-muted hover:text-thermal-text'}`}>Invert</button>
              <div className="w-px h-5 bg-thermal-border" />
              <span className="font-display text-[0.55rem] text-thermal-muted uppercase tracking-wider">Overlay</span>
              <div className="flex rounded-lg bg-black/20 p-0.5">
                <button onClick={() => setOverlay(o => ({ ...o, showMinMaxSpots: !o.showMinMaxSpots }))}
                  title="Show min/max temperature markers"
                  className={`px-2.5 py-1.5 rounded-md font-display text-[0.7rem] font-semibold transition-all ${overlay.showMinMaxSpots ? 'bg-thermal-accent text-black shadow-[0_1px_6px] shadow-thermal-accent/30' : 'text-thermal-muted hover:text-thermal-text'}`}>
                  MinMax
                </button>
                <button onClick={() => setOverlay(o => ({ ...o, showEmissivity: !o.showEmissivity }))}
                  title="Show emissivity & file info corner pills"
                  className={`px-2.5 py-1.5 rounded-md font-display text-[0.7rem] font-semibold transition-all ${overlay.showEmissivity ? 'bg-thermal-accent text-black shadow-[0_1px_6px] shadow-thermal-accent/30' : 'text-thermal-muted hover:text-thermal-text'}`}>
                  Info
                </button>
                <button onClick={() => setOverlay(o => ({ ...o, showTimestamp: !o.showTimestamp }))}
                  title="Show file timestamp corner pill"
                  className={`px-2.5 py-1.5 rounded-md font-display text-[0.7rem] font-semibold transition-all ${overlay.showTimestamp ? 'bg-thermal-accent text-black shadow-[0_1px_6px] shadow-thermal-accent/30' : 'text-thermal-muted hover:text-thermal-text'}`}>
                  Time
                </button>
              </div>
              <div className="w-px h-5 bg-thermal-border" />
              <span className="font-display text-[0.65rem] text-thermal-muted">
                Window: <span className="text-thermal-cold">{toUnit(rangeMin, tempUnit)}</span>
                <span className="mx-1">–</span>
                <span className="text-thermal-hot">{toUnit(rangeMax, tempUnit)}</span>
                <span className="ml-1">°{tempUnit}</span>
              </span>
              <span className="ml-auto text-[0.6rem] text-thermal-muted font-display">
                Image: {toUnit(activeImage.dataMin, tempUnit)}–{toUnit(activeImage.dataMax, tempUnit)}°{tempUnit}
                {lockScale && (
                  <span className="ml-2">Series: {toUnit(globalRange!.min, tempUnit)}–{toUnit(globalRange!.max, tempUnit)}°{tempUnit}</span>
                )}
              </span>
            </div>

            {isSequence && (
              <SequencePanel
                frames={frames} currentIdx={currentIdx}
                playing={playing} loop={loop} frameMs={frameMs} globalScale={globalScale}
                onSeek={seek}
                onPlayToggle={() => setPlaying(p => !p)}
                onLoopToggle={() => setLoop(l => !l)}
                onFrameMs={setFrameMs}
                onGlobalScaleToggle={toggleGlobalScale}
                renderOpts={thumbOpts}
              />
            )}
          </div>

          <div className="flex items-stretch gap-3" style={{ flexWrap: 'nowrap', minWidth: 'min-content' }}>
            <RangeColorBar palette={palette} scaleMode={scaleMode}
              dataMin={barMin} dataMax={barMax}
              rangeMin={rangeMin} rangeMax={rangeMax} tempUnit={tempUnit}
              height={displayH || 300} inverted={inverted}
              onMinChange={setRangeMin} onMaxChange={setRangeMax} />
            <div className="relative flex-1 overflow-visible" style={{ minWidth: 'min-content' }}>
              <ThermalCanvas
                image={activeImage}
                renderOpts={renderOpts} cursors={displayCursors}
                scale={effectiveScale} tempUnit={tempUnit}
                labelScale={labelScale}
                overlay={overlay}
                fileInfo={fileInfo}
                onCursorAdd={addCursor}
                onHover={setHoverTemp}
                exportRef={exportCanvasRef}
              />
              {hoverTemp !== null && (
                <div className="absolute top-2 right-2 pointer-events-none bg-black/80 backdrop-blur-sm border border-white/10 rounded px-2 py-1 font-display text-xs text-white z-20">
                  {toUnit(hoverTemp, tempUnit)}°{tempUnit}
                </div>
              )}
            </div>
            <CursorPanel cursors={displayCursors} tempUnit={tempUnit} labelScale={labelScale}
              onRename={renameCursor} onDelete={removeCursor} onLabelScaleChange={setLabelScale} />
          </div>

          {isSequence && (
            <div className="grid grid-cols-1 xl:grid-cols-2 gap-3">
              <SequenceChart frames={frames} currentIdx={currentIdx} tempUnit={tempUnit} onSeek={seek} />
              <SequenceStats frames={frames} currentIdx={currentIdx} tempUnit={tempUnit} onSeek={seek} />
            </div>
          )}

          {activeImage.isRecomputable && (
            <CalibrationEditor
              emissivity={editEmissivity} distance={editDistance}
              refTemp={editRefTemp} airTemp={editAirTemp} humidity={editHumidity}
              tempUnit={tempUnit}
              onEmissivity={setEditEmissivity}
              onDistance={setEditDistance}
              onRefTemp={setEditRefTemp}
              onAirTemp={setEditAirTemp}
              onHumidity={setEditHumidity}
            />
          )}
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-px rounded-lg overflow-hidden border border-thermal-border bg-thermal-border">
            <StatPill label="Resolution" value={`${activeImage.width}×${activeImage.height}`} />
            <StatPill label="Emissivity" value={activeImage.emissivity.toFixed(3)} />
            <StatPill label="Air Temp" value={`${toUnit(activeImage.airTemp, tempUnit)}°${tempUnit}`} />
            <StatPill label="Ref Temp" value={`${toUnit(activeImage.refTemp, tempUnit)}°${tempUnit}`} />
            <StatPill label="Distance" value={`${activeImage.distance.toFixed(1)}m`} />
            <StatPill label="Atm Trans" value={activeImage.atmTrans.toFixed(3)} />
          </div>
        </>
      )}
    </div>
  );
}
