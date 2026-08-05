import type { ThermalImage } from '@/lib/types';

/**
 * Two-point calibration for images whose pixels are sensor units.
 *
 * DJI's raw-to-temperature curve is very close to a straight line over the
 * span of one scene — fitting one against the SDK's own output left a residual
 * under 0.3 °C. So two known temperatures in the frame are enough to put a
 * degree scale on an image DJI itself refuses to measure.
 *
 * Accuracy is only ever as good as the two references, and the fit belongs to
 * that capture: the same drone on another flight needs its own.
 */

export interface ReferencePoint {
  /** Pixel value read from the image (sensor units). */
  raw: number;
  /** Temperature actually measured at that spot, in Celsius. */
  celsius: number;
}

export interface Calibration {
  scale: number;
  offset: number;
}

/** Solve celsius = raw * scale + offset through two references. */
export function fitTwoPoint(a: ReferencePoint, b: ReferencePoint): Calibration | null {
  const span = b.raw - a.raw;
  if (!Number.isFinite(span) || Math.abs(span) < 1e-6) return null;
  const scale = (b.celsius - a.celsius) / span;
  if (!Number.isFinite(scale)) return null;
  return { scale, offset: a.celsius - a.raw * scale };
}

/**
 * Return a copy of `image` with the calibration applied.
 *
 * The whole grid is converted, so every existing readout — spot values,
 * min/max markers, the range bar, the sequence chart — reports degrees without
 * knowing anything about calibration.
 */
export function applyCalibration(image: ThermalImage, cal: Calibration): ThermalImage {
  const src = image.celsius;
  const celsius = new Float32Array(src.length);
  let dataMin = Infinity, dataMax = -Infinity, minIdx = 0, maxIdx = 0;
  for (let i = 0; i < src.length; i++) {
    const c = src[i] * cal.scale + cal.offset;
    celsius[i] = c;
    if (c < dataMin) { dataMin = c; minIdx = i; }
    if (c > dataMax) { dataMax = c; maxIdx = i; }
  }
  const w = image.width;
  return {
    ...image,
    celsius,
    dataMin,
    dataMax,
    cdfLut: buildCDF(celsius),
    minSpot: { x: minIdx % w, y: Math.floor(minIdx / w), tempC: dataMin },
    maxSpot: { x: maxIdx % w, y: Math.floor(maxIdx / w), tempC: dataMax },
    calibrated: true,
    calibration: cal,
  };
}

/** Undo a previously applied calibration, returning to sensor units. */
export function removeCalibration(image: ThermalImage): ThermalImage {
  const cal = image.calibration;
  if (!cal || cal.scale === 0) return image;
  const inverse: Calibration = { scale: 1 / cal.scale, offset: -cal.offset / cal.scale };
  const restored = applyCalibration(image, inverse);
  return { ...restored, calibrated: false, calibration: undefined };
}

function buildCDF(celsius: Float32Array): Float32Array {
  const BINS = 1024;
  let lo = Infinity, hi = -Infinity;
  for (let i = 0; i < celsius.length; i++) {
    if (celsius[i] < lo) lo = celsius[i];
    if (celsius[i] > hi) hi = celsius[i];
  }
  const span = hi - lo || 1;
  const hist = new Uint32Array(BINS);
  for (let i = 0; i < celsius.length; i++) {
    const bin = Math.floor(((celsius[i] - lo) / span) * (BINS - 1));
    hist[Math.max(0, Math.min(BINS - 1, bin))]++;
  }
  const lut = new Float32Array(BINS);
  let acc = 0;
  for (let i = 0; i < BINS; i++) { acc += hist[i]; lut[i] = acc / celsius.length; }
  return lut;
}
