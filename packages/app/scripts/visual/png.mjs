/**
 * A PNG reader and a tolerance comparison, in Node's own `zlib`.
 *
 * Comparing screenshots byte-for-byte does not work here and never will: the
 * welcome screen is a 70px blur over three blended SVG radial gradients, and
 * Chromium's blur is separable-convolution arithmetic whose last bit depends on
 * the tile boundaries the compositor happened to pick. Two runs of the SAME
 * frame, same clock, same viewport, agree on composition and disagree on the
 * final bit of a few channels. So the comparison is a per-channel tolerance,
 * and the tolerance is the deliverable — see `docs/visual-baseline.mdx`.
 *
 * Scope: 8-bit, non-interlaced, colour type 2 (RGB) or 6 (RGBA). That is what
 * Chromium's screenshot encoder emits; anything else throws rather than being
 * silently mis-read.
 */
import { inflateSync } from 'node:zlib';

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/**
 * @typedef {{ width: number, height: number, channels: number, data: Buffer }} Raster
 */

/** Paeth predictor, straight from the PNG spec. */
function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}

/**
 * @param {Buffer} buffer
 * @returns {Raster}
 */
export function decodePng(buffer) {
  if (!buffer.subarray(0, 8).equals(SIGNATURE)) throw new Error('not a PNG');

  let offset = 8;
  let header = null;
  /** @type {Buffer[]} */
  const idat = [];

  while (offset < buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString('ascii', offset + 4, offset + 8);
    const body = buffer.subarray(offset + 8, offset + 8 + length);
    offset += 12 + length; // length + type + body + crc

    if (type === 'IHDR') {
      header = {
        width: body.readUInt32BE(0),
        height: body.readUInt32BE(4),
        bitDepth: body[8],
        colorType: body[9],
        interlace: body[12],
      };
    } else if (type === 'IDAT') {
      idat.push(body);
    } else if (type === 'IEND') {
      break;
    }
  }

  if (!header) throw new Error('PNG has no IHDR');
  if (header.bitDepth !== 8) throw new Error(`unsupported bit depth ${header.bitDepth}`);
  if (header.interlace !== 0) throw new Error('interlaced PNG is not supported');
  const channels = header.colorType === 6 ? 4 : header.colorType === 2 ? 3 : 0;
  if (!channels) throw new Error(`unsupported colour type ${header.colorType}`);

  const { width, height } = header;
  const stride = width * channels;
  const raw = inflateSync(Buffer.concat(idat));
  const out = Buffer.alloc(stride * height);

  for (let y = 0; y < height; y += 1) {
    const filter = raw[y * (stride + 1)];
    const line = raw.subarray(y * (stride + 1) + 1, y * (stride + 1) + 1 + stride);
    const cur = out.subarray(y * stride, y * stride + stride);
    const prev = y > 0 ? out.subarray((y - 1) * stride, y * stride) : null;

    for (let x = 0; x < stride; x += 1) {
      const left = x >= channels ? cur[x - channels] : 0;
      const up = prev ? prev[x] : 0;
      const upLeft = prev && x >= channels ? prev[x - channels] : 0;
      const value = line[x];
      switch (filter) {
        case 0:
          cur[x] = value;
          break;
        case 1:
          cur[x] = (value + left) & 0xff;
          break;
        case 2:
          cur[x] = (value + up) & 0xff;
          break;
        case 3:
          cur[x] = (value + ((left + up) >> 1)) & 0xff;
          break;
        case 4:
          cur[x] = (value + paeth(left, up, upLeft)) & 0xff;
          break;
        default:
          throw new Error(`unknown scanline filter ${filter} on row ${y}`);
      }
    }
  }

  return { width, height, channels, data: out };
}

/**
 * @typedef {object} Comparison
 * @property {boolean} ok            Every channel within `tolerance`.
 * @property {string} [reason]       Set when the two cannot be compared at all.
 * @property {number} maxDelta       Largest absolute per-channel difference.
 * @property {number} offending      Pixels with at least one channel over tolerance.
 * @property {number} changed        Pixels differing at all, however slightly.
 * @property {number} pixels         Total pixels compared.
 * @property {{x: number, y: number, delta: number}} [worst] Where `maxDelta` was found.
 */

/**
 * Compares two rasters channel by channel.
 *
 * `maxDelta` is reported whether or not it passes, because the number is the
 * evidence: a run whose worst channel moved by 2 is the same composition, and a
 * run whose worst channel moved by 90 is a different picture no matter how few
 * pixels it touched.
 *
 * @param {Raster} a
 * @param {Raster} b
 * @param {number} tolerance
 * @returns {Comparison}
 */
export function compareRasters(a, b, tolerance) {
  const empty = { ok: false, maxDelta: 255, offending: 0, changed: 0, pixels: 0 };
  if (a.width !== b.width || a.height !== b.height) {
    return { ...empty, reason: `size ${a.width}x${a.height} vs ${b.width}x${b.height}` };
  }
  if (a.channels !== b.channels) {
    return { ...empty, reason: `channels ${a.channels} vs ${b.channels}` };
  }

  const { width, height, channels } = a;
  let maxDelta = 0;
  let offending = 0;
  let changed = 0;
  let worst = { x: 0, y: 0, delta: 0 };

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const base = (y * width + x) * channels;
      let pixelDelta = 0;
      for (let c = 0; c < channels; c += 1) {
        const delta = Math.abs(a.data[base + c] - b.data[base + c]);
        if (delta > pixelDelta) pixelDelta = delta;
      }
      if (pixelDelta === 0) continue;
      changed += 1;
      if (pixelDelta > tolerance) offending += 1;
      if (pixelDelta > maxDelta) {
        maxDelta = pixelDelta;
        worst = { x, y, delta: pixelDelta };
      }
    }
  }

  return {
    ok: offending === 0,
    maxDelta,
    offending,
    changed,
    pixels: width * height,
    worst,
  };
}

/**
 * @param {Buffer} a
 * @param {Buffer} b
 * @param {number} tolerance
 * @returns {Comparison}
 */
export function comparePngs(a, b, tolerance) {
  return compareRasters(decodePng(a), decodePng(b), tolerance);
}
