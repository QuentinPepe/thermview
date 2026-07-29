import { toUnit } from '@/lib/units';
import { formatTimestamp } from '@/lib/sequence';
import type { SequenceFrame } from '@/lib/sequence';
import type { TempUnit } from '@/lib/types';

/** Per-image min / mean / max recap table — also the accessible view of the chart. */
export function SequenceStats({ frames, currentIdx, tempUnit, onSeek }: {
  frames: SequenceFrame[];
  currentIdx: number;
  tempUnit: TempUnit;
  onSeek: (idx: number) => void;
}) {
  if (frames.length < 2) return null;

  const thCls = 'px-2 py-1.5 font-display text-[0.55rem] text-thermal-muted uppercase tracking-wider text-right';
  const tdCls = 'px-2 py-1 font-display text-[0.65rem] tabular-nums text-right';

  return (
    <div className="bg-thermal-surface/80 rounded-lg px-4 py-3">
      <div className="flex items-center gap-2 mb-2">
        <div className="size-1.5 rounded-full bg-thermal-accent shadow-[0_0_6px] shadow-thermal-accent/40" />
        <span className="font-display text-[0.6rem] text-thermal-heading tracking-[0.14em] uppercase">Series summary</span>
        <span className="font-display text-[0.55rem] text-thermal-muted">°{tempUnit} — click a row to jump to that image</span>
      </div>
      <div className="overflow-y-auto max-h-56">
        <table className="w-full border-collapse">
          <thead className="sticky top-0 bg-thermal-surface">
            <tr>
              <th className={`${thCls} text-left`}>#</th>
              <th className={`${thCls} text-left`}>File</th>
              <th className={`${thCls} text-left`}>Time</th>
              <th className={thCls}>Min</th>
              <th className={thCls}>Mean</th>
              <th className={thCls}>Max</th>
            </tr>
          </thead>
          <tbody>
            {frames.map((f, i) => (
              <tr key={i} onClick={() => onSeek(i)}
                className={`cursor-pointer border-t border-thermal-border/50 transition-colors ${i === currentIdx ? 'bg-thermal-accent/10' : 'hover:bg-white/5'}`}>
                <td className={`${tdCls} text-left ${i === currentIdx ? 'text-thermal-accent' : 'text-thermal-muted'}`}>{i + 1}</td>
                <td className={`${tdCls} text-left text-thermal-text max-w-40 truncate`} title={f.image.fileName}>{f.image.fileName || '—'}</td>
                <td className={`${tdCls} text-left text-thermal-muted`}>{formatTimestamp(f.timestamp)}</td>
                <td className={tdCls} style={{ color: '#3b82f6' }}>{toUnit(f.image.dataMin, tempUnit)}</td>
                <td className={tdCls} style={{ color: '#0d9488' }}>{toUnit(f.mean, tempUnit)}</td>
                <td className={tdCls} style={{ color: '#ef4444' }}>{toUnit(f.image.dataMax, tempUnit)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
