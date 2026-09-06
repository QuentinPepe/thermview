import type { TempUnit } from '@/lib/types';

export function toUnit(celsius: number, unit: TempUnit): string {
  if (unit === 'F') return ((celsius * 9) / 5 + 32).toFixed(1);
  return celsius.toFixed(1);
}

/**
 * Axis step for a span: 1, 2 or 5 times a power of ten, the smallest that
 * keeps the tick count at or under `maxTicks`. A 30 °C window and a
 * 3000-unit sensor scale both end up with a handful of labels.
 */
export function tickStep(span: number, maxTicks: number): number {
  if (!(span > 0)) return 1;
  let mag = Math.pow(10, Math.floor(Math.log10(span / maxTicks)));
  for (;;) {
    for (const m of [1, 2, 5]) {
      if (span / (m * mag) <= maxTicks) return m * mag;
    }
    mag *= 10;
  }
}
