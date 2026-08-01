import { decode as decodePNG } from 'fast-png';
import { raw2tempCelsius, calculateTau, buildCDF } from '@/lib/flir-parser';
import type { ThermalImage } from '@/lib/types';

/**
 * Parse standalone FLIR FFF frames — single .fff/.img files and multi-frame
 * .seq video recordings (a .seq is FFF frames concatenated back to back).
 *
 * Unlike the legacy AFF path (SC2000-era cameras, centi-Kelvin pixels), an FFF
 * frame carries a record directory with:
 *   - CameraInfo (type 32): Planck constants + object parameters
 *   - RawData   (type 1):  sensor AD counts — uncompressed uint16, or PNG
 * so temperatures come from the same Planck conversion as R-JPEG files.
 *
 * References: exiftool FLIR tags (FFF record layout, CameraInfo offsets),
 * Thermimage raw2temp, flirpy seq splitter.
 */

/** Read the record-directory location from an FFF file header, detecting byte
 *  order: cameras write it big-endian, ResearchIR writes it little-endian. */
function readFFFDirectory(view: DataView, at: number):
  { idxOff: number; nEntries: number; be: boolean } | null {
  for (const be of [true, false]) {
    const idxOff = view.getUint32(at + 0x18, !be);
    const n = view.getUint32(at + 0x1c, !be);
    if (idxOff >= 0x40 && idxOff < 0x1000 && n > 0 && n <= 100) {
      return { idxOff, nEntries: n, be };
    }
  }
  return null;
}

/** Locate frame start offsets in a (possibly multi-frame) FFF buffer. */
export function findFFFFrameOffsets(bytes: Uint8Array): number[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const offsets: number[] = [];
  for (let i = 0; i < bytes.length - 0x40; i++) {
    if (bytes[i] !== 0x46 || bytes[i + 1] !== 0x46 || bytes[i + 2] !== 0x46 || bytes[i + 3] !== 0x00) continue;
    // Validate: a real frame header has a sane record directory just after it.
    if (readFFFDirectory(view, i) !== null) {
      offsets.push(i);
      i += 0x40; // skip past this header
    }
  }
  return offsets;
}

/** Parse one FFF frame into a ThermalImage. Throws when the frame lacks the
 *  records this decoder needs (caller may fall back to the legacy AFF path). */
export function parseFFFFrame(frame: Uint8Array, fileName?: string): ThermalImage {
  const view = new DataView(frame.buffer, frame.byteOffset, frame.byteLength);

  const magic = String.fromCharCode(frame[0], frame[1], frame[2]);
  if (magic !== 'FFF' && magic !== 'AFF') {
    throw new Error(`Not an FFF frame (magic "${magic}")`);
  }

  const dir = readFFFDirectory(view, 0);
  if (dir === null || dir.idxOff + dir.nEntries * 32 > frame.length) {
    throw new Error('Invalid FFF record directory');
  }
  const { idxOff, nEntries, be } = dir;

  interface Rec { type: number; offset: number; length: number }
  const records: Rec[] = [];
  for (let i = 0; i < nEntries; i++) {
    const off = idxOff + i * 32;
    const t = view.getUint16(off, !be);
    const o = view.getUint32(off + 12, !be);
    const l = view.getUint32(off + 16, !be);
    if (t >= 1 && o > 0 && o + l <= frame.length) records.push({ type: t, offset: o, length: l });
  }

  const camRec = records.find(r => r.type === 32);
  const rawRec = records.find(r => r.type === 1);
  if (!camRec) throw new Error('No CameraInfo record (type 32) in FFF frame');
  if (!rawRec) throw new Error('No RawData record (type 1) in FFF frame');

  // ── CameraInfo: object parameters + Planck constants (same layout as R-JPEG) ──
  const base = camRec.offset;
  const f32 = (off: number) => view.getFloat32(off, true);
  const emissivity = f32(base + 0x20);
  const distance = f32(base + 0x24);
  const refTempK = f32(base + 0x28);
  const atmosTempK = f32(base + 0x2C);
  const humidityFrac = f32(base + 0x3C);
  const planckR1 = f32(base + 0x58);
  const planckB = f32(base + 0x5C);
  const planckF = f32(base + 0x60);
  const { planckO, planckR2 } = findPlanckOR2(frame, base, camRec.length);
  if (!(planckR1 > 0) || !(planckB > 500) || planckO === null) {
    throw new Error('FFF CameraInfo has no usable Planck calibration');
  }

  // ── Frame timestamp (epoch seconds + ms + timezone minutes at +0x384) ──
  let frameEpochMs: number | null = null;
  if (base + 0x38e <= frame.length) {
    // exiftool convention: stored seconds minus timezone minutes gives UTC
    const sec = view.getUint32(base + 0x384, true);
    const ms = view.getUint32(base + 0x388, true);
    const tzMin = view.getInt16(base + 0x38c, true);
    const t = (sec - tzMin * 60) * 1000 + (ms < 1000 ? ms : 0);
    // sanity: 2000-01-01 .. 2100-01-01
    if (t > 946684800000 && t < 4102444800000) frameEpochMs = t;
  }

  // ── RawData: dimensions from the frame header, pixels after 0x20 bytes ──
  const rawOff = rawRec.offset;
  const byteOrderMarker = view.getUint16(rawOff, true);
  const isLE = byteOrderMarker < 0x0100;
  const u16 = (off: number) => view.getUint16(off, isLE);
  const sensorW = u16(rawOff + 2);
  const sensorH = u16(rawOff + 4);
  const cropX1 = u16(rawOff + 10), cropX2 = u16(rawOff + 12);
  const cropY1 = u16(rawOff + 14), cropY2 = u16(rawOff + 16);
  let w = cropX2 - cropX1 + 1;
  let h = cropY2 - cropY1 + 1;
  if (!(w > 0 && h > 0 && w <= 4096 && h <= 4096)) { w = sensorW; h = sensorH; }
  if (!(w > 0 && h > 0 && w <= 4096 && h <= 4096)) {
    throw new Error(`Invalid FFF frame dimensions: ${w}x${h}`);
  }

  const rawValues = decodeRawPixels(frame.subarray(rawOff, rawOff + rawRec.length), w, h, isLE);

  // ── Planck conversion ──
  const refTempC = refTempK > 0 ? refTempK - 273.15 : 20;
  const atmosTempC = atmosTempK > 0 ? atmosTempK - 273.15 : 20;
  const humidity = humidityFrac > 0 && humidityFrac <= 1 ? humidityFrac * 100 : 50;
  const em = emissivity > 0 && emissivity <= 1 ? emissivity : 0.95;
  const dist = distance > 0 ? distance : 1;
  const r2 = planckR2 ?? 0.012545258;

  const pixelCount = w * h;
  const celsius = new Float32Array(pixelCount);
  let dataMin = Infinity, dataMax = -Infinity, minIdx = 0, maxIdx = 0;
  for (let i = 0; i < pixelCount; i++) {
    const c = raw2tempCelsius(
      rawValues[i], em, dist,
      refTempC, atmosTempC, atmosTempC, 1.0, humidity,
      planckR1, planckB, planckF || 1, planckO, r2,
    );
    celsius[i] = c;
    if (c > -273.1 && c < dataMin) { dataMin = c; minIdx = i; }
    if (c > dataMax) { dataMax = c; maxIdx = i; }
  }

  return {
    width: w,
    height: h,
    celsius,
    dataMin,
    dataMax,
    cdfLut: buildCDF(celsius),
    minSpot: { x: minIdx % w, y: Math.floor(minIdx / w), tempC: dataMin },
    maxSpot: { x: maxIdx % w, y: Math.floor(maxIdx / w), tempC: dataMax },
    coarseData: new Uint8Array(0),
    emissivity: em,
    airTemp: atmosTempC,
    distance: dist,
    humidity,
    refTemp: refTempC,
    atmTrans: calculateTau(dist, atmosTempC, humidity),
    fileName: fileName || '',
    fileModified: frameEpochMs,
    isRecomputable: true,
    rawValues: rawValues.slice(),
    planckR1,
    planckB,
    planckF: planckF || 1,
    planckO,
    planckR2: r2,
  };
}

/** Cap for very long recordings: frames are sampled evenly beyond this. */
export const SEQ_MAX_FRAMES = 60;

/** Parse a .seq recording (or single-frame FFF file) into ThermalImages. */
export function parseFLIRSEQ(buffer: ArrayBuffer, fileName?: string): ThermalImage[] {
  const bytes = new Uint8Array(buffer);
  const offsets = findFFFFrameOffsets(bytes);
  if (offsets.length === 0) throw new Error('No FFF frames found in file');

  // Evenly sample long recordings so a 30 min video stays loadable.
  let picked = offsets.map((off, i) => ({ off, i }));
  if (picked.length > SEQ_MAX_FRAMES) {
    const step = (picked.length - 1) / (SEQ_MAX_FRAMES - 1);
    const sampled: typeof picked = [];
    for (let k = 0; k < SEQ_MAX_FRAMES; k++) sampled.push(picked[Math.round(k * step)]);
    picked = sampled;
  }

  const stem = (fileName || 'seq').replace(/\.[^.]+$/, '');
  const pad = String(offsets.length).length;
  const images: ThermalImage[] = [];
  const errors: string[] = [];
  for (const { off, i } of picked) {
    const end = offsets[offsets.indexOf(off) + 1] ?? bytes.length;
    try {
      images.push(parseFFFFrame(bytes.subarray(off, end),
        offsets.length > 1 ? `${stem}#${String(i + 1).padStart(pad, '0')}` : fileName));
    } catch (err) {
      errors.push(`frame ${i + 1}: ${(err as Error).message}`);
    }
  }
  if (images.length === 0) {
    throw new Error(`No decodable FFF frames (${errors[0] ?? 'unknown error'})`);
  }
  return images;
}

// ── Raw pixel decoding: uncompressed uint16, PNG, or plain TIFF ─────────────
// Shared with the R-JPEG parser, whose raw record uses the same encodings.

export function decodeRawPixels(rec: Uint8Array, w: number, h: number, isLE: boolean): Uint16Array {
  // PNG-compressed raw (newer cameras) — stored big-endian-swapped
  const png = findPNG(rec);
  if (png) {
    const decoded = decodePNG(png);
    if (decoded.depth !== 16 || decoded.channels !== 1) {
      throw new Error(`Unexpected raw PNG: depth=${decoded.depth} channels=${decoded.channels}`);
    }
    const vals = decoded.data as Uint16Array;
    for (let i = 0; i < vals.length; i++) {
      const v = vals[i];
      vals[i] = ((v >> 8) | ((v & 0xFF) << 8)) & 0xFFFF;
    }
    return checkCount(vals, w, h);
  }

  // TIFF-wrapped raw (Duo Pro R, SC660, …): pixels sit at the strip offsets
  // declared in the IFD, not at a fixed position after the record header.
  const tiff = decodeTIFF16(rec);
  if (tiff) return checkCount(tiff, w, h);

  // Uncompressed: 0x20-byte raw-data header, then w*h uint16 pixels
  const need = w * h * 2;
  if (rec.length >= 0x20 + need) {
    const out = new Uint16Array(w * h);
    const dv = new DataView(rec.buffer, rec.byteOffset + 0x20, need);
    for (let i = 0; i < out.length; i++) out[i] = dv.getUint16(i * 2, isLE);
    return out;
  }

  throw new Error('RawData record is neither PNG, TIFF, nor uncompressed uint16');
}

/** Minimal TIFF reader for FLIR raw thermal data: uncompressed 16-bit,
 *  single sample, strip layout. Returns undefined when the record is not TIFF
 *  or uses features outside that envelope. */
function decodeTIFF16(rec: Uint8Array): Uint16Array | undefined {
  // TIFF header usually starts right after the 0x20-byte raw-data header
  let start = -1;
  for (let i = 0; i < Math.min(rec.length - 8, 0x100); i++) {
    if ((rec[i] === 0x49 && rec[i + 1] === 0x49 && rec[i + 2] === 0x2A && rec[i + 3] === 0x00) ||
        (rec[i] === 0x4D && rec[i + 1] === 0x4D && rec[i + 2] === 0x00 && rec[i + 3] === 0x2A)) {
      start = i; break;
    }
  }
  if (start < 0) return undefined;

  const le = rec[start] === 0x49;
  const dv = new DataView(rec.buffer, rec.byteOffset + start, rec.length - start);
  const u16 = (o: number) => dv.getUint16(o, le);
  const u32 = (o: number) => dv.getUint32(o, le);

  const ifdOff = u32(4);
  if (ifdOff + 2 > dv.byteLength) return undefined;
  const n = u16(ifdOff);

  let width = 0, height = 0, bits = 0, compression = 1;
  let stripOffsets: number[] = [], stripCounts: number[] = [];

  const readValues = (entry: number, type: number, count: number): number[] => {
    const size = type === 3 ? 2 : 4;
    const inline = size * count <= 4;
    const at = inline ? entry + 8 : u32(entry + 8);
    const out: number[] = [];
    for (let k = 0; k < count; k++) out.push(type === 3 ? u16(at + k * 2) : u32(at + k * 4));
    return out;
  };

  for (let i = 0; i < n; i++) {
    const e = ifdOff + 2 + i * 12;
    if (e + 12 > dv.byteLength) return undefined;
    const tag = u16(e), type = u16(e + 2), count = u32(e + 4);
    if (type !== 3 && type !== 4) continue;
    const vals = readValues(e, type, count);
    if (tag === 256) width = vals[0];
    else if (tag === 257) height = vals[0];
    else if (tag === 258) bits = vals[0];
    else if (tag === 259) compression = vals[0];
    else if (tag === 273) stripOffsets = vals;
    else if (tag === 279) stripCounts = vals;
  }

  if (compression !== 1 || bits !== 16 || width <= 0 || height <= 0 || stripOffsets.length === 0) {
    return undefined;
  }

  const out = new Uint16Array(width * height);
  let px = 0;
  for (let s = 0; s < stripOffsets.length && px < out.length; s++) {
    const bytes = stripCounts[s] ?? (out.length - px) * 2;
    const off = stripOffsets[s];
    if (off + bytes > dv.byteLength) return undefined;
    for (let b = 0; b + 1 < bytes && px < out.length; b += 2) {
      out[px++] = dv.getUint16(off + b, le);
    }
  }
  return px === out.length ? out : undefined;
}

function checkCount(vals: Uint16Array, w: number, h: number): Uint16Array {
  if (vals.length < w * h) throw new Error(`Raw pixel count ${vals.length} < ${w}x${h}`);
  return vals.length === w * h ? vals : vals.slice(0, w * h);
}

function findPNG(data: Uint8Array): Uint8Array | undefined {
  const SIG = [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A];
  for (let i = 0; i < Math.min(data.length - 8, 0x100); i++) {
    let ok = true;
    for (let j = 0; j < 8; j++) if (data[i + j] !== SIG[j]) { ok = false; break; }
    if (ok) return data.subarray(i);
  }
  return undefined;
}

// ── Planck O/R2 ─────────────────────────────────────────────────────────────
// exiftool documents fixed CameraInfo offsets: PlanckO int32 at +0x308,
// PlanckR2 float32 at +0x30c. Fall back to a scan for cameras that deviate.

function findPlanckOR2(frame: Uint8Array, base: number, length: number):
  { planckO: number | null; planckR2: number | null } {
  const view = new DataView(frame.buffer, frame.byteOffset, frame.byteLength);

  if (base + 0x310 <= frame.length) {
    const o = view.getInt32(base + 0x308, true);
    const r2 = view.getFloat32(base + 0x30c, true);
    if (o < 0 && o > -100000 && r2 > 0 && r2 <= 100 && Number.isFinite(r2)) {
      return { planckO: o, planckR2: r2 };
    }
  }

  const end = Math.min(base + length, frame.length - 8);
  let best: { o: number; r2: number } | null = null;
  for (let i = base; i < end; i++) {
    const o = view.getInt32(i, true);
    if (o > -20000 && o < -100) {
      const r2 = view.getFloat32(i + 4, true);
      if (r2 > 0.005 && r2 < 0.1 && (best === null || o < best.o)) best = { o, r2 };
    }
  }
  return best ? { planckO: best.o, planckR2: best.r2 } : { planckO: null, planckR2: null };
}
