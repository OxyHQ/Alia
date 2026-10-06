/**
 * The browser's whole input vocabulary, and the download filter.
 */
import { Readable } from 'node:stream';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { captureDownload, MAX_DOWNLOAD_BYTES, safeFileName, sniffType, type DownloadSource } from '../browser/downloads.js';
import { ALLOWED_KEYS, browserInputSchema, describeInput } from '../browser/input.js';

describe('browser input', () => {
  it.each([
    { type: 'click', x: 0, y: 0 },
    { type: 'click', x: 1279, y: 799 },
    { type: 'type', text: 'hola' },
    { type: 'key', key: 'Enter' },
    { type: 'key', key: 'Shift+Tab' },
    { type: 'scroll', deltaY: -600 },
    { type: 'scroll', deltaY: 5000, deltaX: -5000 },
  ])('accepts %j', (input) => {
    expect(browserInputSchema.safeParse(input).success).toBe(true);
  });

  it.each([
    [{ type: 'click', x: 1280, y: 10 }, 'x past the viewport'],
    [{ type: 'click', x: 10, y: 800 }, 'y past the viewport'],
    [{ type: 'click', x: -1, y: 0 }, 'negative'],
    [{ type: 'click', x: 1.5, y: 2 }, 'fractional'],
    [{ type: 'type', text: '' }, 'empty text'],
    [{ type: 'type', text: 'x'.repeat(2001) }, 'too much text'],
    [{ type: 'key', key: 'Control+Shift+I' }, 'devtools chord'],
    [{ type: 'key', key: 'F12' }, 'devtools key'],
    [{ type: 'key', key: 'Control+w' }, 'close tab'],
    [{ type: 'key', key: 'Alt+F4' }, 'close window'],
    [{ type: 'scroll', deltaY: 5001 }, 'scroll too far'],
    [{ type: 'evaluate', script: 'document.cookie' }, 'script evaluation'],
    [{ type: 'click', x: 1, y: 1, selector: '#login' }, 'a selector smuggled beside a click'],
    [{ type: 'upload', path: '/workspace/secret' }, 'a file upload'],
  ])('refuses %j (%s)', (input, _why) => {
    expect(browserInputSchema.safeParse(input).success).toBe(false);
  });

  it('allows no modifier chord beyond select-all', () => {
    const chords = ALLOWED_KEYS.filter((key) => key.includes('+'));
    expect(chords.sort()).toEqual(['Control+a', 'Meta+a', 'Shift+Tab']);
  });

  it('never puts typed text in a description', () => {
    expect(describeInput({ type: 'type', text: 'hunter2' })).toBe('type 7 characters');
    expect(describeInput({ type: 'click', x: 3, y: 4 })).toBe('click 3,4');
  });
});

describe('downloads', () => {
  let directory: string;
  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'alia-dl-'));
  });
  afterEach(() => rmSync(directory, { recursive: true, force: true }));

  const source = (name: string, chunks: Buffer[]) => {
    const calls = { cancel: 0, delete: 0 };
    const value: DownloadSource = {
      suggestedFilename: () => name,
      createReadStream: async () => Readable.from(chunks),
      cancel: async () => {
        calls.cancel += 1;
      },
      delete: async () => {
        calls.delete += 1;
      },
    };
    return { value, calls };
  };

  it('recognises documents and images by their bytes', () => {
    expect(sniffType(Buffer.from('%PDF-1.7\n'))).toBe('application/pdf');
    expect(sniffType(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0]))).toBe('image/png');
    expect(sniffType(Buffer.from([0xff, 0xd8, 0xff, 0xe0]))).toBe('image/jpeg');
    expect(sniffType(Buffer.from('PK\u0003\u0004rest', 'latin1'))).toBe('application/zip');
    expect(sniffType(Buffer.from('name,amount\nana,3\n'))).toBe('text/plain');
    expect(sniffType(Buffer.from('café — ok'))).toBe('text/plain');
  });

  it('refuses executables and other binaries', () => {
    expect(sniffType(Buffer.from([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1, 0]))).toBeNull();
    expect(sniffType(Buffer.from('MZ\u0090\u0000', 'latin1'))).toBeNull();
    expect(sniffType(Buffer.alloc(0))).toBeNull();
  });

  it('keeps only a safe base name', () => {
    expect(safeFileName('../../etc/passwd')).toBe('passwd');
    expect(safeFileName('..\\..\\boot.ini')).toBe('boot.ini');
    expect(safeFileName('.bashrc')).toBe('bashrc');
    expect(safeFileName('factura marzo (2).pdf')).toBe('factura marzo (2).pdf');
    expect(safeFileName('')).toBe('download');
  });

  it('captures a PDF', async () => {
    const { value, calls } = source('invoice.pdf', [Buffer.from('%PDF-1.4 body')]);
    const result = await captureDownload({ source: value, directory, limitReached: false });
    expect(result).toMatchObject({ ok: true, download: { name: 'invoice.pdf', mimeType: 'application/pdf', size: 13 } });
    expect(calls.delete).toBe(1);
  });

  it('cancels and discards a download past the cap', async () => {
    const big = Buffer.alloc(1024 * 1024, 0x41);
    const chunks = Array.from({ length: Math.ceil(MAX_DOWNLOAD_BYTES / big.length) + 1 }, () => big);
    const { value, calls } = source('huge.txt', chunks);
    const result = await captureDownload({ source: value, directory, limitReached: false });
    expect(result).toMatchObject({ ok: false, failure: { reason: 'too_large' } });
    expect(calls.cancel).toBe(1);
    expect(readdirSync(directory)).toEqual([]);
  });

  it('discards an unsupported type and refuses past the per-actor limit', async () => {
    const elf = source('tool', [Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0, 0])]);
    expect(await captureDownload({ source: elf.value, directory, limitReached: false })).toMatchObject({
      ok: false,
      failure: { reason: 'unsupported_type' },
    });
    expect(readdirSync(directory)).toEqual([]);
    const late = source('one-too-many.pdf', [Buffer.from('%PDF-')]);
    expect(await captureDownload({ source: late.value, directory, limitReached: true })).toMatchObject({
      ok: false,
      failure: { reason: 'limit' },
    });
    expect(late.calls.cancel).toBe(1);
  });
});
