/**
 * The three readers, against archives built the way real ones are.
 *
 * A zip written by `zip(1)` and a tarball written by GitHub carry entry types
 * and modes that a hand-rolled fixture does not, so these build real archives
 * with the same libraries that read them and assert on what survives the trip —
 * in particular that a symlink arrives FLAGGED rather than silently as an empty
 * file, since that flag is the whole of `bundle.ts`'s defence against one.
 */

import { randomBytes } from 'node:crypto';
import { mkdtemp, rm, symlink, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import AdmZip from 'adm-zip';
import { c as createTar } from 'tar';
import { afterAll, describe, expect, it } from 'vitest';
import { MAX_BUNDLE_BYTES } from '../bundle.js';
import { readSkillDirectory, readTarGzArchive, readZipArchive } from '../archive.js';

const scratch: string[] = [];

async function scratchDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'alia-skill-'));
  scratch.push(dir);
  return dir;
}

afterAll(async () => {
  await Promise.all(scratch.map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('readZipArchive', () => {
  it('reads entries with their paths and skips directories', () => {
    const zip = new AdmZip();
    zip.addFile('my-skill/SKILL.md', Buffer.from('---\nname: x\n---\n'));
    zip.addFile('my-skill/scripts/run.sh', Buffer.from('echo hi'));
    const files = readZipArchive(zip.toBuffer());
    expect(files.map((f) => f.path).sort()).toEqual([
      'my-skill/SKILL.md',
      'my-skill/scripts/run.sh',
    ]);
    expect(files.find((f) => f.path.endsWith('run.sh'))!.content.toString()).toBe('echo hi');
  });

  it('refuses a buffer that is not a zip', () => {
    expect(() => readZipArchive(Buffer.from('not a zip'))).toThrow(/not a readable zip/);
  });
});

/** Compressible, but well inside the ratio tar refuses past. */
function repeatedBlock(size: number): Buffer {
  const block = randomBytes(64 * 1024);
  return Buffer.concat(
    Array.from({ length: Math.ceil(size / block.length) }, () => block),
  ).subarray(0, size);
}

describe('readTarGzArchive', () => {
  it('reads a gzipped tarball the way GitHub serves one', async () => {
    const dir = await scratchDir();
    await mkdir(join(dir, 'repo-sha/skills/pdf'), { recursive: true });
    await writeFile(join(dir, 'repo-sha/skills/pdf/SKILL.md'), '---\nname: pdf\n---\n');
    await writeFile(join(dir, 'repo-sha/README.md'), '# repo');
    const buffer = await createTar({ gzip: true, cwd: dir }, ['repo-sha']).concat();

    const { files } = await readTarGzArchive(Buffer.from(buffer));
    expect(files.map((f) => f.path).sort()).toEqual([
      'repo-sha/README.md',
      'repo-sha/skills/pdf/SKILL.md',
    ]);
  });

  it('counts only the entries the caller keeps toward the size limit', async () => {
    const dir = await scratchDir();
    await mkdir(join(dir, 'repo-sha/skills'), { recursive: true });
    await mkdir(join(dir, 'repo-sha/vendor'), { recursive: true });
    await writeFile(join(dir, 'repo-sha/skills/SKILL.md'), '---\nname: a\n---\n');
    // Larger than a bundle may be, but outside the directory that was asked for.
    await writeFile(join(dir, 'repo-sha/vendor/blob.bin'), repeatedBlock(MAX_BUNDLE_BYTES + 1));
    const buffer = Buffer.from(await createTar({ gzip: true, cwd: dir }, ['repo-sha']).concat());

    await expect(readTarGzArchive(buffer)).rejects.toThrow(/expands past/);
    const { files } = await readTarGzArchive(buffer, (path) => path.startsWith('repo-sha/skills/'));
    expect(files.map((f) => f.path)).toEqual(['repo-sha/skills/SKILL.md']);
  });

  it('flags a symlink instead of reading through it', async () => {
    const dir = await scratchDir();
    await mkdir(join(dir, 'pkg'), { recursive: true });
    await writeFile(join(dir, 'pkg/real.md'), '# real');
    await symlink('../../../etc/passwd', join(dir, 'pkg/link.md'));
    const buffer = await createTar({ gzip: true, cwd: dir }, ['pkg']).concat();

    const { files } = await readTarGzArchive(Buffer.from(buffer));
    const link = files.find((f) => f.path.endsWith('link.md'));
    expect(link?.symlink).toBe(true);
    expect(link?.content.byteLength).toBe(0);
  });

  // tar parses leniently: garbage produces no entries rather than an error, so
  // the refusal comes from the empty result and says both things it could be.
  it('refuses a buffer that is not a tarball', async () => {
    await expect(readTarGzArchive(Buffer.from('nope'))).rejects.toThrow(
      /not readable, or holds no files/,
    );
  });
});

describe('readSkillDirectory', () => {
  it('walks a directory into posix-relative paths and keeps the executable bit', async () => {
    const dir = await scratchDir();
    await mkdir(join(dir, 'scripts'), { recursive: true });
    await writeFile(join(dir, 'SKILL.md'), '---\nname: x\n---\n');
    await writeFile(join(dir, 'scripts/run.sh'), 'echo hi', { mode: 0o755 });

    const files = await readSkillDirectory(dir);
    expect(files.map((f) => f.path).sort()).toEqual(['SKILL.md', 'scripts/run.sh']);
    expect((files.find((f) => f.path === 'scripts/run.sh')!.mode! & 0o111) !== 0).toBe(true);
  });

  it('reports a symlink rather than following it', async () => {
    const dir = await scratchDir();
    await writeFile(join(dir, 'SKILL.md'), '---\nname: x\n---\n');
    await symlink('/etc/passwd', join(dir, 'passwd.md'));
    const files = await readSkillDirectory(dir);
    expect(files.find((f) => f.path === 'passwd.md')?.symlink).toBe(true);
  });
});
