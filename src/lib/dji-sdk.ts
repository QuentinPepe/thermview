import type { ThermalImage } from '@/lib/types';

/**
 * Desktop-only bridge to DJI's Thermal SDK.
 *
 * Newer DJI cameras map their raw values through a per-image calibration curve
 * that is not derivable from the file, so the JS parser rejects them rather
 * than report wrong temperatures. In the desktop build (when compiled with
 * `--features dji-sdk`) we hand the file to DJI's own library instead.
 */

interface DjiThermal {
  width: number;
  height: number;
  celsius: number[];
  distance: number;
  humidity: number;
  emissivity: number;
  reflection: number;
}

type Invoke = <T>(cmd: string, args?: unknown) => Promise<T>;

function invoker(): Invoke | null {
  const w = window as unknown as {
    __TAURI_INTERNALS__?: { invoke?: Invoke };
  };
  return w.__TAURI_INTERNALS__?.invoke ?? null;
}

let availability: Promise<boolean> | null = null;

/** Whether the running build can measure DJI files through the SDK. */
export function djiSdkAvailable(): Promise<boolean> {
  if (availability) return availability;
  const invoke = invoker();
  availability = invoke
    ? invoke<boolean>('dji_sdk_available').catch(() => false)
    : Promise.resolve(false);
  return availability;
}

/**
 * Measure a DJI R-JPEG via the SDK.
 *
 * Returns null only when there is no SDK to ask — a build without the feature,
 * or the browser. A failure *inside* the SDK throws, so the caller can report
 * what actually went wrong instead of a generic "unsupported camera".
 */
export async function measureDjiWithSdk(
  buffer: ArrayBuffer,
  fileName: string,
  modified: number | null,
): Promise<ThermalImage | null> {
  const invoke = invoker();
  if (!invoke || !(await djiSdkAvailable())) return null;

  // Sent as a raw body: a JSON array of a million numbers took seconds.
  const r = await invoke<DjiThermal>('dji_measure', new Uint8Array(buffer));

  const celsius = Float32Array.from(r.celsius);
  let dataMin = Infinity, dataMax = -Infinity, minIdx = 0, maxIdx = 0;
  for (let i = 0; i < celsius.length; i++) {
    const c = celsius[i];
    if (c < dataMin) { dataMin = c; minIdx = i; }
    if (c > dataMax) { dataMax = c; maxIdx = i; }
  }

  return {
    width: r.width,
    height: r.height,
    celsius,
    dataMin,
    dataMax,
    cdfLut: buildCDF(celsius),
    minSpot: { x: minIdx % r.width, y: Math.floor(minIdx / r.width), tempC: dataMin },
    maxSpot: { x: maxIdx % r.width, y: Math.floor(maxIdx / r.width), tempC: dataMax },
    coarseData: new Uint8Array(0),
    emissivity: r.emissivity,
    airTemp: r.reflection,
    distance: r.distance,
    humidity: r.humidity,
    refTemp: r.reflection,
    atmTrans: 1,
    fileName,
    fileModified: modified,
    // The SDK owns the radiometry; re-deriving it here would contradict it.
    isRecomputable: false,
    rawValues: null,
    planckR1: 0,
    planckB: 0,
    planckF: 0,
    planckO: 0,
    planckR2: 0,
  };
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
