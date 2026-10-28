/**
 * What a model that reads no files gets from a PDF (`person-files.ts`): its
 * text, or, when it has none, its first pages as images.
 *
 * ## A scan is read by the model's vision
 *
 * A scanned PDF is pictures of pages with no text layer, so text extraction
 * finds nothing. Rather than tell the model "it may be a scan", Alia hands it
 * the scanned pages themselves and the model reads them, which is OCR done by
 * the vision the model already has, with no OCR engine in Alia.
 *
 * The page is not rendered (that needs a native canvas); its scan is taken
 * from the PDF instead. A scanned page is one large image drawn over the page,
 * so the page's largest image is the page. pdf.js decodes it (JPEG, JPEG 2000,
 * JBIG2, CCITT, Flate) into raw pixels, and this module scales it down and
 * encodes it as PNG with `node:zlib`, so nothing here is native.
 *
 * ## Bounds
 *
 * - At most {@link MAX_SCANNED_PAGES} pages, the first ones.
 * - Each page at most {@link MAX_PAGE_IMAGE_EDGE} pixels on its long side
 *   (about 115 dpi on a Letter or A4 page, where body text stays legible), in
 *   grey when the scan is grey (most are), with the paper's grain whitened. A
 *   page that does not fit what is left of the byte bound is tried once more at
 *   two thirds of that size.
 * - At most {@link MAX_SCANNED_PDF_IMAGE_BYTES} of PNG per document, so the
 *   pages fit Oxy's inference request (`MAX_REQUEST_BYTES`, 768 KiB of JSON,
 *   in which the PNG travels as base64). The pages that do not fit are left
 *   out, and the model is told which pages it has.
 * - pdf.js decodes no image above {@link MAX_DECODED_IMAGE_PIXELS}.
 */
import { deflateSync } from 'node:zlib';
import { extractText, getDocumentProxy, getResolvedPDFJS } from 'unpdf';

/** The first pages of a scan the model is shown. */
export const MAX_SCANNED_PAGES = 8;
/** The long side of a page image, in pixels. */
export const MAX_PAGE_IMAGE_EDGE = 1280;
/** The PNG bytes one scanned document contributes, summed over its pages. */
export const MAX_SCANNED_PDF_IMAGE_BYTES = 480 * 1024;
/** Larger images are not decoded at all (a 600-dpi A4 page is 35 megapixels). */
export const MAX_DECODED_IMAGE_PIXELS = 25_000_000;
/** An image smaller than this on its long side is a logo or a stamp, not a page. */
const MIN_PAGE_IMAGE_EDGE = 300;
/** Grey at or above this is paper, not ink. */
const PAPER_WHITE = 224;
/** How long a decoded image may take to arrive from pdf.js before the page is skipped. */
const IMAGE_WAIT_MS = 5_000;

export interface PdfPageImage {
  /** One-based. */
  readonly page: number;
  readonly png: Uint8Array;
}

export type PdfReading =
  | { readonly kind: 'text'; readonly text: string }
  | { readonly kind: 'pages'; readonly pageCount: number; readonly pages: readonly PdfPageImage[] };

/** pdf.js `ImageKind`. */
const GRAYSCALE_1BPP = 1;
const RGB_24BPP = 2;
const RGBA_32BPP = 3;

interface DecodedImage {
  width: number;
  height: number;
  kind?: number;
  data?: Uint8Array | Uint8ClampedArray;
}

interface Raster {
  width: number;
  height: number;
  channels: 1 | 3;
  data: Uint8Array;
}

/** Raw pixels as 8-bit grey or RGB, or `undefined` for a layout this does not know. */
function rasterOf(image: DecodedImage): Raster | undefined {
  const { width, height, kind, data } = image;
  if (!data || width <= 0 || height <= 0) return undefined;
  const pixels = width * height;
  if (kind === GRAYSCALE_1BPP) {
    const stride = Math.ceil(width / 8);
    if (data.length < stride * height) return undefined;
    const grey = new Uint8Array(pixels);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        grey[y * width + x] = data[y * stride + (x >> 3)] & (0x80 >> (x & 7)) ? 255 : 0;
      }
    }
    return { width, height, channels: 1, data: grey };
  }
  if (kind === RGB_24BPP && data.length >= pixels * 3) {
    return { width, height, channels: 3, data: Uint8Array.from(data.subarray(0, pixels * 3)) };
  }
  if (kind === RGBA_32BPP && data.length >= pixels * 4) {
    const rgb = new Uint8Array(pixels * 3);
    for (let i = 0; i < pixels; i++) {
      const alpha = data[i * 4 + 3];
      for (let c = 0; c < 3; c++) {
        rgb[i * 3 + c] = Math.round((data[i * 4 + c] * alpha + 255 * (255 - alpha)) / 255);
      }
    }
    return { width, height, channels: 3, data: rgb };
  }
  return undefined;
}

/** Grey when at most one pixel in a hundred has visible colour: a scanned page on white paper. */
function toGreyIfGrey(raster: Raster): Raster {
  if (raster.channels === 1) return raster;
  const pixels = raster.width * raster.height;
  const { data } = raster;
  let coloured = 0;
  const allowed = Math.floor(pixels / 100);
  for (let i = 0; i < pixels; i++) {
    const r = data[i * 3];
    const g = data[i * 3 + 1];
    const b = data[i * 3 + 2];
    if (Math.max(r, g, b) - Math.min(r, g, b) > 24 && ++coloured > allowed) return raster;
  }
  const grey = new Uint8Array(pixels);
  for (let i = 0; i < pixels; i++) {
    grey[i] = Math.round(0.299 * data[i * 3] + 0.587 * data[i * 3 + 1] + 0.114 * data[i * 3 + 2]);
  }
  return { ...raster, channels: 1, data: grey };
}

/**
 * Near-white grey becomes white. A scanner records the paper's grain as noise
 * that PNG cannot compress, and on a page of text that noise is most of the
 * bytes; the text, far darker, is untouched.
 */
function whitenPaper(raster: Raster): Raster {
  if (raster.channels !== 1) return raster;
  const data = raster.data.map((value) => (value >= PAPER_WHITE ? 255 : value));
  return { ...raster, data };
}

/** Area-averaged so the long side is at most `maxEdge`; a smaller image is returned as is. */
export function downscale(raster: Raster, maxEdge: number): Raster {
  const { width, height, channels, data } = raster;
  const scale = Math.min(1, maxEdge / Math.max(width, height));
  if (scale === 1) return raster;
  const outWidth = Math.max(1, Math.round(width * scale));
  const outHeight = Math.max(1, Math.round(height * scale));
  const out = new Uint8Array(outWidth * outHeight * channels);
  const xStart = new Uint32Array(outWidth + 1);
  for (let x = 0; x <= outWidth; x++) xStart[x] = Math.floor((x * width) / outWidth);
  const sums = new Float64Array(channels);
  for (let y = 0; y < outHeight; y++) {
    const y0 = Math.floor((y * height) / outHeight);
    const y1 = Math.max(y0 + 1, Math.floor(((y + 1) * height) / outHeight));
    for (let x = 0; x < outWidth; x++) {
      const x0 = xStart[x];
      const x1 = Math.max(x0 + 1, xStart[x + 1]);
      sums.fill(0);
      for (let sy = y0; sy < y1; sy++) {
        let index = (sy * width + x0) * channels;
        for (let sx = x0; sx < x1; sx++) {
          for (let c = 0; c < channels; c++) sums[c] += data[index++];
        }
      }
      const area = (y1 - y0) * (x1 - x0);
      const target = (y * outWidth + x) * channels;
      for (let c = 0; c < channels; c++) out[target + c] = Math.round(sums[c] / area);
    }
  }
  return { width: outWidth, height: outHeight, channels, data: out };
}

/** Turned clockwise by a page's `/Rotate` (0, 90, 180 or 270). */
function rotate(raster: Raster, degrees: number): Raster {
  const turns = (((Math.round(degrees / 90) % 4) + 4) % 4) as 0 | 1 | 2 | 3;
  if (turns === 0) return raster;
  const { width, height, channels, data } = raster;
  const outWidth = turns === 2 ? width : height;
  const outHeight = turns === 2 ? height : width;
  const out = new Uint8Array(data.length);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const [tx, ty] =
        turns === 1
          ? [height - 1 - y, x]
          : turns === 2
            ? [width - 1 - x, height - 1 - y]
            : [y, width - 1 - x];
      const from = (y * width + x) * channels;
      const to = (ty * outWidth + tx) * channels;
      for (let c = 0; c < channels; c++) out[to + c] = data[from + c];
    }
  }
  return { width: outWidth, height: outHeight, channels, data: out };
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type: string, body: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + body.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, body.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(body, 8);
  view.setUint32(8 + body.length, crc32(out.subarray(4, 8 + body.length)));
  return out;
}

function paeth(left: number, up: number, upLeft: number): number {
  const estimate = left + up - upLeft;
  const toLeft = Math.abs(estimate - left);
  const toUp = Math.abs(estimate - up);
  const toUpLeft = Math.abs(estimate - upLeft);
  return toLeft <= toUp && toLeft <= toUpLeft ? left : toUp <= toUpLeft ? up : upLeft;
}

/**
 * An 8-bit grey or RGB PNG. Each row takes whichever of the None, Sub, Up and
 * Paeth filters leaves the smallest residuals, the usual heuristic: scanned
 * text compresses several times better filtered than raw.
 */
export function encodePng(raster: Raster): Uint8Array {
  const { width, height, channels, data } = raster;
  const stride = width * channels;
  const filtered = new Uint8Array((stride + 1) * height);
  const candidate = new Uint8Array(stride);
  const best = new Uint8Array(stride);
  for (let y = 0; y < height; y++) {
    const row = data.subarray(y * stride, (y + 1) * stride);
    const above = y === 0 ? undefined : data.subarray((y - 1) * stride, y * stride);
    let bestFilter = 0;
    let bestScore = Number.POSITIVE_INFINITY;
    for (const filter of [0, 1, 2, 4]) {
      let score = 0;
      for (let i = 0; i < stride; i++) {
        const left = i >= channels ? row[i - channels] : 0;
        const up = above ? above[i] : 0;
        const upLeft = above && i >= channels ? above[i - channels] : 0;
        const predicted =
          filter === 0 ? 0 : filter === 1 ? left : filter === 2 ? up : paeth(left, up, upLeft);
        const value = (row[i] - predicted) & 0xff;
        candidate[i] = value;
        score += value < 128 ? value : 256 - value;
      }
      if (score < bestScore) {
        bestScore = score;
        bestFilter = filter;
        best.set(candidate);
      }
    }
    filtered[y * (stride + 1)] = bestFilter;
    filtered.set(best, y * (stride + 1) + 1);
  }
  const header = new Uint8Array(13);
  const view = new DataView(header.buffer);
  view.setUint32(0, width);
  view.setUint32(4, height);
  header[8] = 8;
  header[9] = channels === 1 ? 0 : 2;
  const signature = Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a);
  const parts = [
    signature,
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(filtered, { level: 9 })),
    chunk('IEND', new Uint8Array()),
  ];
  const png = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    png.set(part, offset);
    offset += part.length;
  }
  return png;
}

type PdfDocument = Awaited<ReturnType<typeof getDocumentProxy>>;
type PdfPage = Awaited<ReturnType<PdfDocument['getPage']>>;

function decodedImage(page: PdfPage, key: unknown): Promise<DecodedImage | undefined> {
  if (key !== null && typeof key === 'object') return Promise.resolve(key as DecodedImage);
  if (typeof key !== 'string') return Promise.resolve(undefined);
  const store = key.startsWith('g_') ? page.commonObjs : page.objs;
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(undefined), IMAGE_WAIT_MS);
    timer.unref?.();
    store.get(key, (image: DecodedImage | null) => {
      clearTimeout(timer);
      resolve(image ?? undefined);
    });
  });
}

/** The largest image drawn on the page, if it is large enough to be the page itself. */
async function pageScan(page: PdfPage): Promise<Raster | undefined> {
  const { OPS } = await getResolvedPDFJS();
  const operators = await page.getOperatorList();
  let largest: DecodedImage | undefined;
  for (let i = 0; i < operators.fnArray.length; i++) {
    const operator = operators.fnArray[i];
    if (operator !== OPS.paintImageXObject && operator !== OPS.paintInlineImageXObject) continue;
    const image = await decodedImage(page, operators.argsArray[i]?.[0]);
    if (!image?.data || !image.width || !image.height) continue;
    if (!largest || image.width * image.height > largest.width * largest.height) largest = image;
  }
  if (!largest || Math.max(largest.width, largest.height) < MIN_PAGE_IMAGE_EDGE) return undefined;
  return rasterOf(largest);
}

async function scannedPages(document: PdfDocument): Promise<PdfPageImage[]> {
  const pages: PdfPageImage[] = [];
  let budget = MAX_SCANNED_PDF_IMAGE_BYTES;
  const last = Math.min(document.numPages, MAX_SCANNED_PAGES);
  for (let number = 1; number <= last; number++) {
    const page = await document.getPage(number);
    try {
      const scan = await pageScan(page);
      if (!scan) continue;
      const upright = rotate(toGreyIfGrey(scan), page.rotate);
      let png = encodePng(whitenPaper(downscale(upright, MAX_PAGE_IMAGE_EDGE)));
      if (png.length > budget) {
        png = encodePng(whitenPaper(downscale(upright, Math.round((MAX_PAGE_IMAGE_EDGE * 2) / 3))));
      }
      if (png.length > budget) break;
      budget -= png.length;
      pages.push({ page: number, png });
    } finally {
      page.cleanup();
    }
  }
  return pages;
}

/** The PDF's text; when it has none, its first scanned pages as PNG. */
export async function readPdf(bytes: Uint8Array): Promise<PdfReading> {
  const document = await getDocumentProxy(bytes, {
    verbosity: 0,
    maxImageSize: MAX_DECODED_IMAGE_PIXELS,
  });
  try {
    const { text } = await extractText(document, { mergePages: true });
    if (text.trim() !== '') return { kind: 'text', text };
    return { kind: 'pages', pageCount: document.numPages, pages: await scannedPages(document) };
  } finally {
    await document.loadingTask.destroy();
  }
}
