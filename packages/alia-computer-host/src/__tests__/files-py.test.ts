/**
 * `workspace-image/files.py`, run for real by python3 against a temporary
 * directory standing in for `/workspace` (`--root`, which the host never
 * passes). This is the second path gate — the one that runs inside the
 * container — and the only one that can see a symlink.
 */
import { spawnSync } from 'node:child_process';
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const SCRIPT = join(import.meta.dirname, '..', '..', 'workspace-image', 'files.py');
const python = spawnSync('python3', ['--version']).status === 0;

let root: string;
let outside: string;

function run(request: Record<string, unknown>): {
  ok: boolean;
  body: Record<string, unknown> | null;
  error: string;
} {
  const result = spawnSync('python3', ['-I', SCRIPT, '--root', root], {
    input: JSON.stringify(request),
    encoding: 'utf8',
  });
  return {
    ok: result.status === 0,
    body: result.status === 0 ? (JSON.parse(result.stdout) as Record<string, unknown>) : null,
    error: result.stderr.trim(),
  };
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'alia-ws-'));
  outside = mkdtempSync(join(tmpdir(), 'alia-outside-'));
  writeFileSync(join(outside, 'secret'), 'host secret');
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
});

describe.skipIf(!python)('files.py', () => {
  it('writes atomically, reads back, lists and makes directories', () => {
    expect(run({ operation: 'mkdir', path: '/workspace/src/lib' }).ok).toBe(true);
    expect(
      run({ operation: 'write', path: '/workspace/src/lib/a.txt', text: 'hola' }).body,
    ).toEqual({ path: '/workspace/src/lib/a.txt', bytes: 4 });
    expect(run({ operation: 'read', path: '/workspace/src/lib/a.txt' }).body).toEqual({
      path: '/workspace/src/lib/a.txt',
      text: 'hola',
    });
    const listing = run({ operation: 'list', path: '/workspace/src' }).body;
    expect(listing).toMatchObject({
      entries: [{ name: 'lib', type: 'directory' }],
      truncated: false,
    });
    // No temporary file is left behind.
    expect(readdirSync(join(root, 'src', 'lib'))).toEqual(['a.txt']);
  });

  it('writes a download as bytes, creating its directory and never replacing a file', () => {
    const data = Buffer.from('%PDF-1.7 fake').toString('base64');
    expect(
      run({ operation: 'write_bytes', path: '/workspace/downloads/report.pdf', data }).body,
    ).toEqual({ path: '/workspace/downloads/report.pdf', bytes: 13 });
    expect(
      run({ operation: 'write_bytes', path: '/workspace/downloads/report.pdf', data }).body,
    ).toEqual({ path: '/workspace/downloads/report (1).pdf', bytes: 13 });
    expect(readFileSync(join(root, 'downloads', 'report (1).pdf'), 'utf8')).toBe('%PDF-1.7 fake');
  });

  it('refuses a download through a planted symlink, and invalid base64', () => {
    symlinkSync(outside, join(root, 'downloads'));
    expect(
      run({ operation: 'write_bytes', path: '/workspace/downloads/x.pdf', data: 'aGk=' }).ok,
    ).toBe(false);
    expect(readdirSync(outside)).toEqual(['secret']);
    expect(run({ operation: 'write_bytes', path: '/workspace/y.bin', data: '***' }).ok).toBe(false);
  });

  it('refuses to read through a symlinked file or directory', () => {
    symlinkSync(join(outside, 'secret'), join(root, 'link'));
    symlinkSync(outside, join(root, 'dir'));
    expect(run({ operation: 'read', path: '/workspace/link' })).toMatchObject({ ok: false });
    expect(run({ operation: 'read', path: '/workspace/dir/secret' })).toMatchObject({ ok: false });
    expect(run({ operation: 'list', path: '/workspace/dir' })).toMatchObject({ ok: false });
  });

  it('refuses to write through or over a symlink', () => {
    symlinkSync(join(outside, 'secret'), join(root, 'link'));
    symlinkSync(outside, join(root, 'dir'));
    expect(run({ operation: 'write', path: '/workspace/link', text: 'pwned' }).ok).toBe(false);
    expect(run({ operation: 'write', path: '/workspace/dir/new', text: 'pwned' }).ok).toBe(false);
    expect(readFileSync(join(outside, 'secret'), 'utf8')).toBe('host secret');
    expect(readdirSync(outside)).toEqual(['secret']);
  });

  it.each(['/workspace/../etc/passwd', '/etc/passwd', 'workspace/a', '/workspace/a\u0000b'])(
    'refuses the path %j',
    (path) => {
      expect(run({ operation: 'read', path }).ok).toBe(false);
    },
  );

  it('enforces the 256 KB limit both ways', () => {
    expect(
      run({ operation: 'write', path: '/workspace/big', text: 'x'.repeat(256 * 1024 + 1) }),
    ).toMatchObject({
      ok: false,
      error: 'File exceeds size limit',
    });
    writeFileSync(join(root, 'big'), 'x'.repeat(256 * 1024 + 1));
    expect(run({ operation: 'read', path: '/workspace/big' }).error).toBe(
      'File exceeds size limit',
    );
  });

  it('refuses binary content rather than corrupting it', () => {
    writeFileSync(join(root, 'bin'), Buffer.from([0xff, 0xfe, 0x00]));
    expect(run({ operation: 'read', path: '/workspace/bin' }).ok).toBe(false);
  });

  it('refuses an operation it does not know', () => {
    mkdirSync(join(root, 'd'));
    expect(run({ operation: 'delete', path: '/workspace/d' })).toMatchObject({
      ok: false,
      error: 'Unsupported file operation',
    });
  });
});
