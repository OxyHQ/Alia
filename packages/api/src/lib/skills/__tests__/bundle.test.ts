/**
 * What Alia will and will not store as a skill bundle.
 *
 * The entries of an uploaded archive are hostile input — a repository nobody
 * here wrote, unpacked by a server. Each refusal below is a real archive shape,
 * not a hypothetical one: zip-slip, absolute paths, Windows separators and
 * symlinks all appear in the wild, and a bundle that "worked" past any of them
 * would be a path traversal with a progress bar.
 */

import { describe, expect, it } from 'vitest';
import {
  MAX_BUNDLE_BYTES,
  MAX_FILES,
  MAX_INLINE_BYTES,
  type RawFile,
  buildSkillBundle,
  splitSkillDirectories,
} from '../bundle.js';

const DOCUMENT = `---
name: pdf-processing
description: Extracts text from PDF files. Use when the user mentions PDFs.
---

# PDF Processing
`;

function file(path: string, content: string | Buffer, extra: Partial<RawFile> = {}): RawFile {
  return { path, content: typeof content === 'string' ? Buffer.from(content) : content, ...extra };
}

describe('buildSkillBundle', () => {
  it('refuses a bundle with no SKILL.md', () => {
    expect(() => buildSkillBundle([file('README.md', '# hi')])).toThrow(/no SKILL.md/);
  });

  it('keeps the document body on the bundle and out of the file list', () => {
    const bundle = buildSkillBundle([file('SKILL.md', DOCUMENT), file('references/FORMS.md', '# Forms')]);
    expect(bundle.document.body).toBe('# PDF Processing');
    expect(bundle.files.map((f) => f.path)).toEqual(['references/FORMS.md']);
  });

  it.each([
    ['../escape.md', /escapes the skill directory/],
    ['nested/../../escape.md', /escapes the skill directory/],
    ['/etc/passwd', /absolute path/],
    ['scripts\\run.sh', /backslashes/],
    ['C:/windows/system32', /Windows drive path/],
  ])('refuses %s', (path, message) => {
    expect(() => buildSkillBundle([file('SKILL.md', DOCUMENT), file(path, 'x')])).toThrow(message);
  });

  it('refuses a symlink, whose target is outside what was validated', () => {
    expect(() =>
      buildSkillBundle([file('SKILL.md', DOCUMENT), file('link.md', '../../secret', { symlink: true })]),
    ).toThrow(/symlink/);
  });

  it('refuses a bundle over the size limit', () => {
    const big = Buffer.alloc(MAX_BUNDLE_BYTES + 1);
    expect(() => buildSkillBundle([file('SKILL.md', DOCUMENT), file('assets/big.bin', big)])).toThrow(
      /larger than/,
    );
  });

  it('refuses a bundle with too many files', () => {
    const files = [file('SKILL.md', DOCUMENT)];
    for (let i = 0; i <= MAX_FILES; i++) files.push(file(`references/r${i}.md`, 'x'));
    expect(() => buildSkillBundle(files)).toThrow(/more than/);
  });

  describe('classification', () => {
    it('reads the spec directories', () => {
      const bundle = buildSkillBundle([
        file('SKILL.md', DOCUMENT),
        file('scripts/run.sh', 'echo hi'),
        file('references/API.md', '# API'),
        file('assets/template.docx', Buffer.from([0x50, 0x4b, 0x03, 0x04])),
      ]);
      expect(Object.fromEntries(bundle.files.map((f) => [f.path, f.kind]))).toEqual({
        'scripts/run.sh': 'script',
        'references/API.md': 'reference',
        'assets/template.docx': 'asset',
      });
    });

    it('falls back to the extension when a skill uses no directories', () => {
      const bundle = buildSkillBundle([
        file('SKILL.md', DOCUMENT),
        file('extract.py', 'print(1)'),
        file('NOTES.md', '# notes'),
      ]);
      const kinds = Object.fromEntries(bundle.files.map((f) => [f.path, f.kind]));
      expect(kinds['extract.py']).toBe('script');
      expect(kinds['NOTES.md']).toBe('reference');
    });

    it('marks a script executable even when the archive carried no mode', () => {
      const bundle = buildSkillBundle([file('SKILL.md', DOCUMENT), file('scripts/run.sh', 'echo hi')]);
      expect(bundle.files[0].executable).toBe(true);
    });
  });

  describe('storage split', () => {
    it('inlines small text and hands binary content back for object storage', () => {
      const bundle = buildSkillBundle([
        file('SKILL.md', DOCUMENT),
        file('references/API.md', '# API'),
        file('assets/logo.png', Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01])),
      ]);
      const byPath = Object.fromEntries(bundle.files.map((f) => [f.path, f]));
      expect(byPath['references/API.md'].contentText).toBe('# API');
      expect(byPath['references/API.md'].content).toBeUndefined();
      expect(byPath['assets/logo.png'].content).toBeInstanceOf(Buffer);
      expect(byPath['assets/logo.png'].contentText).toBeUndefined();
    });

    it('sends oversized text to object storage rather than into a column', () => {
      const bundle = buildSkillBundle([
        file('SKILL.md', DOCUMENT),
        file('references/HUGE.md', 'x'.repeat(MAX_INLINE_BYTES + 1)),
      ]);
      expect(bundle.files[0].contentText).toBeUndefined();
      expect(bundle.files[0].content).toBeInstanceOf(Buffer);
    });

    it('does not inline a .md file that is not valid UTF-8', () => {
      const bundle = buildSkillBundle([
        file('SKILL.md', DOCUMENT),
        file('references/bad.md', Buffer.from([0xff, 0xfe, 0x00, 0x41])),
      ]);
      expect(bundle.files[0].contentText).toBeUndefined();
    });
  });

  describe('checksum', () => {
    const base = [file('SKILL.md', DOCUMENT), file('references/API.md', '# API')];

    it('is stable across file order, so a re-import creates no version', () => {
      expect(buildSkillBundle(base).checksum).toBe(buildSkillBundle([...base].reverse()).checksum);
    });

    it('changes when any byte of any file changes', () => {
      const changed = [file('SKILL.md', DOCUMENT), file('references/API.md', '# API v2')];
      expect(buildSkillBundle(changed).checksum).not.toBe(buildSkillBundle(base).checksum);
    });

    it('changes when the document changes', () => {
      const changed = [file('SKILL.md', `${DOCUMENT}\nmore`), file('references/API.md', '# API')];
      expect(buildSkillBundle(changed).checksum).not.toBe(buildSkillBundle(base).checksum);
    });
  });
});

describe('splitSkillDirectories', () => {
  it('finds every skill in a repository tree and re-roots its files', () => {
    const groups = splitSkillDirectories([
      file('repo-abc/README.md', '# repo'),
      file('repo-abc/skills/pdf/SKILL.md', DOCUMENT),
      file('repo-abc/skills/pdf/references/API.md', '# API'),
      file('repo-abc/skills/xlsx/SKILL.md', DOCUMENT),
    ]);
    expect([...groups.keys()].sort()).toEqual(['repo-abc/skills/pdf', 'repo-abc/skills/xlsx']);
    expect(groups.get('repo-abc/skills/pdf')!.map((f) => f.path).sort()).toEqual([
      'SKILL.md',
      'references/API.md',
    ]);
  });

  it('gives a nested skill its own files rather than its parent claiming them', () => {
    const groups = splitSkillDirectories([
      file('outer/SKILL.md', DOCUMENT),
      file('outer/notes.md', 'x'),
      file('outer/inner/SKILL.md', DOCUMENT),
      file('outer/inner/scripts/go.sh', 'x'),
    ]);
    expect(groups.get('outer')!.map((f) => f.path).sort()).toEqual(['SKILL.md', 'notes.md']);
    expect(groups.get('outer/inner')!.map((f) => f.path).sort()).toEqual(['SKILL.md', 'scripts/go.sh']);
  });

  it('handles an archive whose SKILL.md sits at the root', () => {
    const groups = splitSkillDirectories([file('SKILL.md', DOCUMENT), file('scripts/go.sh', 'x')]);
    expect([...groups.keys()]).toEqual(['']);
    expect(groups.get('')!.map((f) => f.path).sort()).toEqual(['SKILL.md', 'scripts/go.sh']);
  });
});
