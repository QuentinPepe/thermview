import type { ThermalImage } from '@/lib/types';

/**
 * Parse a DJI radiometric JPEG (DTAT3.0 format) into ThermalImage.
 *
 * File structure:
 *   - SOI + APP1 (EXIF with camera metadata)
 *   - APP2 (MPF — Multi-Picture Format)
 *   - APP3 x N (raw thermal sensor data, uint16 LE, 640×512)
 *   - APP4 (calibration parameters as floats)
 *   - JPEG image data (visible/colorized)
 *   - Second JPEG (visible light image)
 *
 * Temperatures come from `raw / 64 = Kelvin`, which holds for the Mavic 2
 * Enterprise Advanced generation. Newer cameras (M3T, M30T, M4T, H20T/H30T)
 * store the same raw layout but map it through a per-image calibration curve
 * that only DJI's Thermal SDK implements; applying the M2EA formula to them
 * silently returns wrong readings, so they are rejected instead.
 * Measured against the DJI SDK on real M4T files: up to 5.6 °C of error on
 * high-gain captures, and ~208 °C on low-gain ones.
 */

/** Cameras whose raw values are Kelvin/64 — the formula below is valid here. */
const KELVIN64_MODELS = [
  'MAVIC2-ENTERPRISE-ADVANCED',
  'M2EA',
  'XT2',
  'XTR',
  'XTS',
];

/** Cameras that need DJI's proprietary radiometric curve. */
const SDK_ONLY_MODELS = [
  'M4T', 'M3T', 'M3TD', 'M30T', 'H20T', 'H20N', 'H30T', 'ZH20T', 'M4TD',
];

export function parseDJI(buffer: ArrayBuffer): ThermalImage {
  const bytes = new Uint8Array(buffer);

  const model = readExifModel(bytes);
  const norm = model ? model.toUpperCase().replace(/^DJI[\s_-]*/, '').trim() : '';
  // Applying the Kelvin/64 formula to these would be wrong by several degrees,
  // so their pixels stay in sensor units until something can calibrate them:
  // DJI's SDK in the desktop build, or a two-point calibration by hand.
  const sdkOnly = norm !== '' && !KELVIN64_MODELS.includes(norm) && SDK_ONLY_MODELS.includes(norm);

  // ── Extract APP3 chunks for raw thermal data ───────────────────────────
  const app3Chunks: Uint8Array[] = [];
  let app4Data: Uint8Array | null = null;

  let i = 0;
  while (i < bytes.length - 4) {
    if (bytes[i] === 0xFF) {
      const marker = bytes[i + 1];
      if (marker >= 0xE0 && marker <= 0xEF) {
        const length = (bytes[i + 2] << 8) | bytes[i + 3];
        if (length < 4) { i++; continue; }
        const contentEnd = i + 2 + length;

        if (marker === 0xE3) {
          // APP3 — raw thermal data
          const chunk = bytes.slice(i + 4, Math.min(contentEnd, bytes.length));
          app3Chunks.push(chunk);
        } else if (marker === 0xE4) {
          // APP4 — calibration parameters
          app4Data = bytes.slice(i + 4, Math.min(contentEnd, bytes.length));
        }

        i = contentEnd;
        continue;
      } else if (marker === 0xD9) {
        // EOI — stop at first JPEG end
        break;
      }
    }
    i++;
  }

  if (app3Chunks.length === 0) {
    throw new Error('No APP3 thermal data found in DJI file');
  }

  // Concatenate APP3 chunks
  const totalApp3Size = app3Chunks.reduce((s, c) => s + c.length, 0);
  const app3Data = new Uint8Array(totalApp3Size);
  let writePos = 0;
  for (const chunk of app3Chunks) {
    app3Data.set(chunk, writePos);
    writePos += chunk.length;
  }

  // ── Determine resolution ────────────────────────────────────────────
  // Standard DJI DTAT3.0 thermal resolution is 640×512, but some cameras
  // produce smaller frames. We detect resolution from data size.
  let width = 640;
  let height = 512;
  let pixelCount = width * height;

  if (app3Data.length < pixelCount * 2) {
    // Try smaller common resolutions
    const totalPixels = Math.floor(app3Data.length / 2);
    // Common DJI resolutions: 640×512, 320×256, 160×120, etc.
    if (totalPixels === 320 * 256) { width = 320; height = 256; pixelCount = totalPixels; }
    else if (totalPixels === 160 * 120) { width = 160; height = 120; pixelCount = totalPixels; }
    else {
      // Fall back to a square-ish shape
      height = Math.floor(Math.sqrt(totalPixels));
      width = Math.floor(totalPixels / height);
      pixelCount = width * height;
    }
  }

  if (app3Data.length < pixelCount * 2) {
    throw new Error(`DJI raw data too small: ${app3Data.length} < ${pixelCount * 2}`);
  }

  // ── Parse raw sensor values ─────────────────────────────────────────
  const rawView = new DataView(app3Data.buffer, app3Data.byteOffset, app3Data.byteLength);
  const rawValues = new Float64Array(pixelCount);

  for (let pi = 0; pi < pixelCount; pi++) {
    rawValues[pi] = rawView.getUint16(pi * 2, true);
  }

  // ── Parse APP4 calibration parameters ────────────────────────────────
  // APP4 contains floats: emissivity, distance, humidity, reflected_temp
  // Also sometimes contains Planck constants
  let emissivity = 0.95;
  let distance = 5.0;
  let humidity = 70.0;
  let refTemp = 23.0;

  if (app4Data && app4Data.length >= 20) {
    const calView = new DataView(app4Data.buffer, app4Data.byteOffset, app4Data.byteLength);
    // offset 0: distance (float32 LE)
    if (calView.byteLength >= 4) distance = calView.getFloat32(0, true);
    // offset 4: humidity (float32 LE)
    if (calView.byteLength >= 8) humidity = calView.getFloat32(4, true);
    // offset 8: emissivity (float32 LE)
    if (calView.byteLength >= 12) emissivity = calView.getFloat32(8, true);
    // offset 12: reflected temperature (float32 LE)
    if (calView.byteLength >= 16) refTemp = calView.getFloat32(12, true);

    // Clamp to valid ranges, and fall back to the defaults rather than let a
    // meaningless APP4 block surface as 0.10 emissivity or a NaN distance —
    // captures the SDK reports zeroed parameters for land here.
    const sane = (v: number, lo: number, hi: number, fallback: number) =>
      Number.isFinite(v) && v >= lo && v <= hi ? v : fallback;
    emissivity = sane(emissivity, 0.1, 1.0, 0.95);
    distance = sane(distance, 0.1, 200, 5.0);
    humidity = sane(humidity, 1, 100, 70.0);
    refTemp = sane(refTemp, -40, 200, 23.0);
  }

  // ── Convert raw sensor values to Celsius ────────────────────────────
  const K_OFFSET = 273.15;
  const celsius = new Float32Array(pixelCount);
  let dataMin = Infinity;
  let dataMax = -Infinity;
  let minIdx = 0;
  let maxIdx = 0;

  for (let pi = 0; pi < pixelCount; pi++) {
    const c = (rawValues[pi] / 64) - K_OFFSET;
    celsius[pi] = c;
    if (c < dataMin) { dataMin = c; minIdx = pi; }
    if (c > dataMax) { dataMax = c; maxIdx = pi; }
  }

  // A scene no thermal camera could see means the Kelvin/64 assumption does not
  // hold — an unlisted camera generation. Treat it like the known ones.
  const implausible = dataMax < -80 || dataMin > 600;

  if (sdkOnly || implausible) {
    // Keep the sensor units themselves; degrees would be fiction.
    dataMin = Infinity; dataMax = -Infinity; minIdx = 0; maxIdx = 0;
    for (let pi = 0; pi < pixelCount; pi++) {
      const v = rawValues[pi];
      celsius[pi] = v;
      if (v < dataMin) { dataMin = v; minIdx = pi; }
      if (v > dataMax) { dataMax = v; maxIdx = pi; }
    }
  }

  // ── Build CDF ──────────────────────────────────────────────────────
  const cdfLut = buildCDF(celsius);

  // ── Try to extract metadata from EXIF ───────────────────────────────
  const airTemp = 20;
  const atmTrans = 1;

  // Parse EXIF APP1 for camera model
  i = 0;
  while (i < bytes.length - 10) {
    if (bytes[i] === 0xFF && bytes[i + 1] === 0xE1) {
      const hdr = String.fromCharCode(...bytes.slice(i + 4, i + 10));
      if (hdr === 'Exif\x00\x00') {
        const tiffStart = i + 10;
        const tiffView = new DataView(buffer, tiffStart);
        const le = tiffView.getUint8(0) === 0x49;
        const ifdOff = tiffView.getUint32(4, le);
        const ifdAbs = tiffStart + ifdOff;
        if (ifdAbs + 2 <= buffer.byteLength) {
          const ifdView = new DataView(buffer, ifdAbs);
          const nEntries = ifdView.getUint16(0, le);
          for (let ei = 0; ei < nEntries && ei < 50; ei++) {
            const es = 2 + ei * 12;
            if (es + 12 > ifdView.byteLength) break;
            const tag = ifdView.getUint16(es, le);
            const typ = ifdView.getUint16(es + 2, le);

            // Object Distance (0x9206)
            if (tag === 0x9206 && typ === 5) {
              const voff = ifdView.getUint32(es + 8, le);
              if (tiffStart + voff + 8 <= buffer.byteLength) {
                const num = ifdView.getUint32(tiffStart + voff, le);
                const den = ifdView.getUint32(tiffStart + voff + 4, le);
                if (den !== 0) distance = num / den;
              }
            }
          }
        }
        break;
      }
    }
    i++;
  }

  return {
    width,
    height,
    celsius,
    dataMin,
    dataMax,
    cdfLut,
    minSpot: { x: minIdx % width, y: Math.floor(minIdx / width), tempC: dataMin },
    maxSpot: { x: maxIdx % width, y: Math.floor(maxIdx / width), tempC: dataMax },
    coarseData: new Uint8Array(0),
    emissivity,
    airTemp,
    distance,
    humidity,
    refTemp,
    atmTrans,
    fileName: '',
    fileModified: null,

    // DJI stores pre-calibrated temperatures, not raw sensor counts.
    isRecomputable: false,
    rawValues: null,
    calibrated: !(sdkOnly || implausible),
    planckR1: 0,
    planckB: 0,
    planckF: 0,
    planckO: 0,
    planckR2: 0,
  };
}

/** Read EXIF IFD0 Model (tag 0x0110) — identifies the DJI camera generation. */
function readExifModel(bytes: Uint8Array): string | null {
  for (let i = 0; i < bytes.length - 10; i++) {
    if (bytes[i] !== 0xFF || bytes[i + 1] !== 0xE1) continue;
    if (String.fromCharCode(...bytes.slice(i + 4, i + 8)) !== 'Exif') continue;

    const tiff = i + 10;
    if (tiff + 8 > bytes.length) return null;
    const view = new DataView(bytes.buffer, bytes.byteOffset + tiff, bytes.byteLength - tiff);
    const le = view.getUint8(0) === 0x49;
    const ifdOff = view.getUint32(4, le);
    if (ifdOff + 2 > view.byteLength) return null;

    const n = view.getUint16(ifdOff, le);
    for (let e = 0; e < n && e < 100; e++) {
      const entry = ifdOff + 2 + e * 12;
      if (entry + 12 > view.byteLength) break;
      if (view.getUint16(entry, le) !== 0x0110) continue;

      const count = view.getUint32(entry + 4, le);
      const at = count <= 4 ? entry + 8 : view.getUint32(entry + 8, le);
      if (at + count > view.byteLength) return null;
      let s = '';
      for (let c = 0; c < count; c++) {
        const ch = view.getUint8(at + c);
        if (ch === 0) break;
        s += String.fromCharCode(ch);
      }
      return s.trim() || null;
    }
    return null;
  }
  return null;
}

/** Build a cumulative-distribution LUT from a Celsius grid (1024 bins). */
function buildCDF(celsius: Float32Array): Float32Array {
  const BINS = 1024;
  let dataMin = Infinity, dataMax = -Infinity;
  for (let i = 0; i < celsius.length; i++) {
    if (celsius[i] < dataMin) dataMin = celsius[i];
    if (celsius[i] > dataMax) dataMax = celsius[i];
  }
  const span = dataMax - dataMin || 1;
  const hist = new Uint32Array(BINS);
  for (let i = 0; i < celsius.length; i++) {
    const bin = Math.floor(((celsius[i] - dataMin) / span) * (BINS - 1));
    hist[Math.max(0, Math.min(BINS - 1, bin))]++;
  }
  const lut = new Float32Array(BINS);
  let acc = 0;
  for (let i = 0; i < BINS; i++) {
    acc += hist[i];
    lut[i] = acc / celsius.length;
  }
  return lut;
}
