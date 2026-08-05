import { useState, useMemo } from 'react';
import { fitTwoPoint } from '@/lib/two-point';
import type { Calibration } from '@/lib/two-point';
import type { MeasurementCursor } from '@/lib/types';

/**
 * Puts a degree scale on an image DJI will not measure.
 *
 * The reference values come from measurement points the user has already
 * placed on the image, so there is nothing to transcribe: click the spot you
 * measured with a thermometer, then type what it read.
 */
export function TwoPointPanel({
  cursors, onApply,
}: {
  cursors: MeasurementCursor[];
  onApply: (cal: Calibration) => void;
}) {
  const [idA, setIdA] = useState<number | null>(null);
  const [idB, setIdB] = useState<number | null>(null);
  const [tempA, setTempA] = useState('');
  const [tempB, setTempB] = useState('');

  const pointA = cursors.find(c => c.id === idA);
  const pointB = cursors.find(c => c.id === idB);

  const result = useMemo(() => {
    if (!pointA || !pointB) return null;
    const a = parseFloat(tempA), b = parseFloat(tempB);
    if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
    if (pointA.id === pointB.id) return null;
    return fitTwoPoint({ raw: pointA.tempC, celsius: a }, { raw: pointB.tempC, celsius: b });
  }, [pointA, pointB, tempA, tempB]);

  const selectCls = 'px-2 py-1.5 bg-black/30 border border-thermal-border rounded-md font-display text-xs text-thermal-heading focus:outline-none focus:border-thermal-accent/50';
  const inputCls = 'w-24 px-2 py-1.5 bg-black/30 border border-thermal-border rounded-md font-display text-xs text-thermal-heading tabular-nums focus:outline-none focus:border-thermal-accent/50';

  const picker = (
    value: number | null,
    onChange: (id: number | null) => void,
    temp: string,
    onTemp: (v: string) => void,
    label: string,
  ) => {
    const point = cursors.find(c => c.id === value);
    return (
      <div className="flex items-center gap-2">
        <span className="font-display text-[0.55rem] text-thermal-muted uppercase tracking-wider w-16">{label}</span>
        <select className={selectCls} value={value ?? ''}
          onChange={e => onChange(e.target.value ? Number(e.target.value) : null)}>
          <option value="">choose a point…</option>
          {cursors.map(c => <option key={c.id} value={c.id}>Point {c.label}</option>)}
        </select>
        <span className="font-display text-[0.65rem] text-thermal-muted tabular-nums w-20">
          {point ? `${point.tempC.toFixed(0)} raw` : '—'}
        </span>
        <span className="font-display text-[0.55rem] text-thermal-muted">measured</span>
        <input className={inputCls} type="number" step="0.1" placeholder="°C"
          value={temp} onChange={e => onTemp(e.target.value)} />
      </div>
    );
  };

  return (
    <div className="bg-thermal-surface/80 rounded-lg px-4 py-3 space-y-2.5">
      <div className="flex items-center gap-2 flex-wrap">
        <div className="size-1.5 rounded-full bg-thermal-hot shadow-[0_0_6px] shadow-thermal-hot/40" />
        <span className="font-display text-[0.6rem] text-thermal-heading tracking-[0.14em] uppercase">
          Uncalibrated — sensor units, not degrees
        </span>
        <span className="font-display text-[0.55rem] text-thermal-muted">
          DJI publishes no conversion for this capture. Relative heat and evolution are still accurate.
        </span>
      </div>

      {cursors.length < 2 ? (
        <p className="font-display text-[0.65rem] text-thermal-muted">
          To read degrees, click two spots on the image whose real temperature you know,
          then enter those temperatures here.
        </p>
      ) : (
        <div className="space-y-2">
          {picker(idA, setIdA, tempA, setTempA, 'Point 1')}
          {picker(idB, setIdB, tempB, setTempB, 'Point 2')}
          <div className="flex items-center gap-3 pt-0.5">
            <button
              onClick={() => result && onApply(result)}
              disabled={!result}
              className="px-3 py-1.5 rounded-md font-display text-[0.7rem] font-semibold transition-all bg-thermal-accent text-black shadow-[0_1px_6px] shadow-thermal-accent/30 disabled:opacity-40"
            >
              Apply to the whole series
            </button>
            {result && (
              <span className="font-display text-[0.6rem] text-thermal-muted tabular-nums">
                {result.scale.toFixed(5)} °C per unit
              </span>
            )}
            {pointA && pointB && pointA.id === pointB.id && (
              <span className="font-display text-[0.6rem] text-thermal-hot">
                pick two different points
              </span>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
