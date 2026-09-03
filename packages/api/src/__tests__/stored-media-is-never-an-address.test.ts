import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * This API does not build storage addresses, anywhere.
 *
 * It used to. `uploadToS3` returned `https://<bucket>.s3.<region>.amazonaws.com/<key>`,
 * that value was stored in seven columns across four tables, and three separate
 * surfaces handed it to clients: the speech endpoint, a conversation's
 * messages, and a show. Every one of them was a 403, because the bucket blocks
 * public access — and a browser reports that as
 * `NotSupportedError: Failed to load because no supported source was found`,
 * which names codecs and means permissions.
 *
 * Fixing the surfaces one at a time did not hold: two more appeared after the
 * first was corrected. So the address is not constructed at all now — an object
 * is identified by its KEY, and `lib/stored-media.ts` is the only thing that
 * turns one into something a client can fetch, on Alia's own domain and with a
 * signature that expires.
 *
 * This census is what stops it coming back the next time someone needs "a URL
 * for the file".
 */

const REPO_ROOT = path.resolve(__dirname, '../../../..');

/**
 * Source with its comments removed.
 *
 * A census over raw text counts the sentence that EXPLAINS the rule as a
 * breach of it — this file's own subject is named in `stored-media.ts`'s
 * header, and the first run flagged it. Stripping is deliberately conservative:
 * block comments and whole-line `//`, nothing that could swallow a string
 * literal, because over-stripping is the direction that makes a census pass by
 * measuring less.
 */
function withoutComments(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .split('\n')
    .filter((line) => !/^\s*\/\//.test(line))
    .join('\n');
}

function trackedSources(): { file: string; text: string }[] {
  const listed = execFileSync('git', ['ls-files', 'packages/api/src'], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
  })
    .split('\n')
    .filter((file) => file.endsWith('.ts') && existsSync(path.join(REPO_ROOT, file)));

  return listed.map((file) => ({
    file,
    text: withoutComments(readFileSync(path.join(REPO_ROOT, file), 'utf8')),
  }));
}

describe('no source builds an address for the media bucket', () => {
  const sources = trackedSources();

  it('finds the files it is meant to be reading', () => {
    // Positive control and vacuity floor. `git ls-files` returns nothing for an
    // untracked path, and a census over nothing reports clean — which is the
    // failure mode this whole file exists to prevent elsewhere.
    expect(sources.length).toBeGreaterThan(300);
    expect(sources.some(({ file }) => file.endsWith('lib/s3.ts'))).toBe(true);
  });

  it('constructs no `s3.<region>.amazonaws.com` address outside its own test', () => {
    const offenders = sources
      .filter(({ file }) => !file.includes('__tests__'))
      .filter(({ text }) => /\.s3\.\$?\{?[^}\s'"`]*\}?\.amazonaws\.com/.test(text) || text.includes('.amazonaws.com/'))
      .map(({ file }) => file);

    expect(offenders).toEqual([]);
  });

  it('names the storage host nowhere in production source', () => {
    // Wider than the shape above: a hardcoded bucket URL, a template, a
    // concatenation. Comments are stripped first, so the paragraphs that
    // explain this rule do not count as breaking it, and the migration that
    // converted stored addresses is SQL rather than source.
    const offenders = sources
      .filter(({ file }) => !file.includes('__tests__'))
      .filter(({ text }) => text.includes('amazonaws.com'))
      .map(({ file }) => file);

    expect(offenders).toEqual([]);
  });

  it('leaves exactly one way to address a stored object', () => {
    // A second one is how the first surface got fixed while two others stayed
    // broken. `storedMediaUrl` is the only producer, and it is a function
    // somebody has to call on purpose.
    const producers = sources
      .filter(({ file }) => !file.includes('__tests__'))
      .filter(({ text }) => text.includes('export function storedMediaUrl'))
      .map(({ file }) => file);

    expect(producers).toEqual(['packages/api/src/lib/stored-media.ts']);
  });
});
