/**
 * A PDF with no text is a scan: its first pages reach the model as PNG images
 * it can read, scaled and bounded, instead of a note that it "may be a scan".
 */
import { describe, expect, it } from 'vitest';
import {
  downscale,
  encodePng,
  MAX_PAGE_IMAGE_EDGE,
  MAX_SCANNED_PAGES,
  MAX_SCANNED_PDF_IMAGE_BYTES,
  readPdf,
} from '../pdf-documents.js';
import { decodePng, greyPage, scannedPdf } from './document-fixtures.js';

describe('encodePng', () => {
  it('writes a PNG whose pixels decode back exactly, grey and colour', () => {
    const grey = { width: 7, height: 5, channels: 1 as const, data: greyPage(7, 5) };
    grey.data[3] = 0;
    expect(decodePng(encodePng(grey))).toEqual({
      width: 7,
      height: 5,
      channels: 1,
      data: grey.data,
    });
    const colour = {
      width: 4,
      height: 3,
      channels: 3 as const,
      data: Uint8Array.from({ length: 36 }, (_, index) => (index * 37) % 256),
    };
    expect(decodePng(encodePng(colour))).toEqual({
      width: 4,
      height: 3,
      channels: 3,
      data: colour.data,
    });
  });

  it('scales by area so the long side fits, and leaves a small image alone', () => {
    const raster = {
      width: 4,
      height: 2,
      channels: 1 as const,
      data: Uint8Array.of(0, 100, 200, 200, 0, 100, 200, 200),
    };
    expect(downscale(raster, 2)).toEqual({
      width: 2,
      height: 1,
      channels: 1,
      data: Uint8Array.of(50, 200),
    });
    expect(downscale(raster, 8)).toBe(raster);
  });
});

describe('readPdf', () => {
  it('gives a scan its pages as upright grey PNGs, scaled to the bound', async () => {
    const reading = await readPdf(
      scannedPdf([
        {
          width: 1700,
          height: 2200,
          colorSpace: 'DeviceGray',
          bitsPerComponent: 8,
          pixels: greyPage(1700, 2200),
        },
        {
          width: 400,
          height: 600,
          colorSpace: 'DeviceGray',
          bitsPerComponent: 1,
          pixels: new Uint8Array(50 * 600).fill(0b11110000),
        },
        {
          width: 400,
          height: 300,
          colorSpace: 'DeviceGray',
          bitsPerComponent: 8,
          pixels: greyPage(400, 300),
          rotate: 90,
        },
      ]),
    );
    expect(reading.kind).toBe('pages');
    if (reading.kind !== 'pages') return;
    expect(reading.pageCount).toBe(3);
    expect(reading.pages.map((page) => page.page)).toEqual([1, 2, 3]);
    const [first, second, third] = reading.pages.map((page) => decodePng(page.png));
    expect(first).toMatchObject({ width: 989, height: MAX_PAGE_IMAGE_EDGE, channels: 1 });
    expect(second).toMatchObject({ width: 400, height: 600, channels: 1 });
    expect([...second.data.subarray(0, 8)]).toEqual([255, 255, 255, 255, 0, 0, 0, 0]);
    expect(third).toMatchObject({ width: 300, height: 400 });
  });

  it('keeps a coloured scan in colour', async () => {
    const pixels = new Uint8Array(400 * 400 * 3);
    for (let i = 0; i < pixels.length; i += 3) pixels.set([200, 30, 30], i);
    const reading = await readPdf(
      scannedPdf([
        { width: 400, height: 400, colorSpace: 'DeviceRGB', bitsPerComponent: 8, pixels },
      ]),
    );
    expect(reading.kind === 'pages' && decodePng(reading.pages[0].png).channels).toBe(3);
  });

  it('skips a page whose only image is a logo, and reads only the first pages', async () => {
    const logo = {
      width: 64,
      height: 64,
      colorSpace: 'DeviceGray' as const,
      bitsPerComponent: 8 as const,
      pixels: greyPage(64, 64),
    };
    const page = {
      width: 500,
      height: 700,
      colorSpace: 'DeviceGray' as const,
      bitsPerComponent: 8 as const,
      pixels: greyPage(500, 700),
    };
    const reading = await readPdf(
      scannedPdf([logo, ...Array.from({ length: MAX_SCANNED_PAGES + 2 }, () => page)]),
    );
    expect(reading.kind === 'pages' && reading.pages.map((p) => p.page)).toEqual(
      Array.from({ length: MAX_SCANNED_PAGES - 1 }, (_, index) => index + 2),
    );
  });

  it('stops adding pages at the byte bound', async () => {
    let seed = 7;
    const noise = () =>
      Uint8Array.from({ length: 450 * 450 }, () => {
        seed = (Math.imul(seed, 1103515245) + 12345) >>> 0;
        return seed >>> 24;
      });
    const page = () => ({
      width: 450,
      height: 450,
      colorSpace: 'DeviceGray' as const,
      bitsPerComponent: 8 as const,
      pixels: noise(),
    });
    const reading = await readPdf(scannedPdf([page(), page(), page()]));
    expect(reading.kind).toBe('pages');
    if (reading.kind !== 'pages') return;
    expect(reading.pages.map((p) => p.page)).toEqual([1, 2]);
    expect(reading.pages.reduce((total, p) => total + p.png.length, 0)).toBeLessThanOrEqual(
      MAX_SCANNED_PDF_IMAGE_BYTES,
    );
  });

  it('says a PDF with neither text nor page images has no pages to show', async () => {
    const blank = {
      width: 1,
      height: 1,
      colorSpace: 'none' as const,
      bitsPerComponent: 8 as const,
      pixels: new Uint8Array(1),
    };
    expect(await readPdf(scannedPdf([blank]))).toEqual({ kind: 'pages', pageCount: 1, pages: [] });
  });
});
