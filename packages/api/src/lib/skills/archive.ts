/**
 * Archives in, `RawFile[]` out.
 *
 * Three sources produce the same shape so that `bundle.ts` is the only place
 * that judges content: a zip somebody uploaded, a tarball GitHub served, and a
 * directory in the image (the built-in skills).
 *
 * ## Nothing is written to disk
 *
 * Neither reader extracts anywhere. An entry is decoded in memory and handed
 * over as bytes with its declared path attached, which is what makes the path
 * rules in `bundle.ts` sufficient: there is no earlier moment at which a
 * traversal could already have escaped, because no file system operation
 * happens before the check.
 *
 * ## The compressed limit is separate from the uncompressed one
 *
 * `MAX_BUNDLE_BYTES` bounds what a skill may contain. It cannot bound what an
 * archive may expand to, because the expansion is what would exhaust memory — so
 * both readers stop as soon as the running total passes the limit, mid-archive,
 * rather than after unpacking it.
 */

import { readFile, readdir, stat } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import AdmZip from 'adm-zip';
import { Parser } from 'tar';
import { MAX_BUNDLE_BYTES, type RawFile } from './bundle.js';

export class SkillArchiveError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SkillArchiveError';
  }
}

/** The high sixteen bits of a zip entry's external attributes are the POSIX mode. */
const S_IFMT = 0o170000;
const S_IFLNK = 0o120000;

export function readZipArchive(buffer: Buffer): RawFile[] {
  let zip: AdmZip;
  try {
    zip = new AdmZip(buffer);
  } catch (err) {
    throw new SkillArchiveError(`the upload is not a readable zip: ${(err as Error).message}`);
  }

  const files: RawFile[] = [];
  let bytes = 0;
  for (const entry of zip.getEntries()) {
    if (entry.isDirectory) continue;
    const mode = (entry.header.attr >>> 16) & 0xffff;
    const symlink = (mode & S_IFMT) === S_IFLNK;
    // `getData` decompresses, so the size check comes from the header first: an
    // archive claiming to expand past the limit is refused before it does.
    bytes += entry.header.size;
    if (bytes > MAX_BUNDLE_BYTES) {
      throw new SkillArchiveError(`the archive expands past ${MAX_BUNDLE_BYTES} bytes`);
    }
    files.push({
      path: entry.entryName,
      content: symlink ? Buffer.alloc(0) : entry.getData(),
      mode,
      symlink,
    });
  }
  if (files.length === 0) throw new SkillArchiveError('the archive holds no files');
  return files;
}

export async function readTarGzArchive(buffer: Buffer): Promise<RawFile[]> {
  const files: RawFile[] = [];
  let bytes = 0;

  await new Promise<void>((resolve, reject) => {
    const parser = new Parser();
    parser.on('entry', (entry) => {
      const symlink = entry.type === 'SymbolicLink' || entry.type === 'Link';
      if (entry.type !== 'File' && !symlink) {
        entry.resume();
        return;
      }
      if (symlink) {
        files.push({ path: String(entry.path), content: Buffer.alloc(0), mode: entry.mode, symlink: true });
        entry.resume();
        return;
      }
      const chunks: Buffer[] = [];
      entry.on('data', (chunk: Buffer) => {
        bytes += chunk.byteLength;
        if (bytes > MAX_BUNDLE_BYTES) {
          reject(new SkillArchiveError(`the archive expands past ${MAX_BUNDLE_BYTES} bytes`));
          parser.abort(new Error('too large'));
          return;
        }
        chunks.push(chunk);
      });
      entry.on('end', () => {
        files.push({ path: String(entry.path), content: Buffer.concat(chunks), mode: entry.mode });
      });
    });
    parser.on('error', (err) => reject(new SkillArchiveError(`the tarball is not readable: ${err.message}`)));
    parser.on('end', () => resolve());
    parser.end(buffer);
  });

  // tar's parser is lenient: bytes that are not a tarball yield no entries and
  // no error, so "unreadable" and "empty" arrive here as the same state and the
  // message has to cover both rather than claim the one it cannot distinguish.
  if (files.length === 0) throw new SkillArchiveError('the tarball is not readable, or holds no files');
  return files;
}

/**
 * A directory in the image, used by the built-in seed.
 *
 * `lstat` rather than `stat`, so a symlink is reported as one instead of being
 * followed — the same rule the archive readers apply, for the same reason.
 */
export async function readSkillDirectory(root: string): Promise<RawFile[]> {
  const files: RawFile[] = [];
  await walk(root, root, files);
  return files;
}

async function walk(root: string, dir: string, files: RawFile[]): Promise<void> {
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isSymbolicLink()) {
      files.push({ path: toPosix(relative(root, full)), content: Buffer.alloc(0), symlink: true });
      continue;
    }
    if (entry.isDirectory()) {
      await walk(root, full, files);
      continue;
    }
    if (!entry.isFile()) continue;
    const info = await stat(full);
    files.push({ path: toPosix(relative(root, full)), content: await readFile(full), mode: info.mode });
  }
}

function toPosix(path: string): string {
  return sep === '/' ? path : path.split(sep).join('/');
}
