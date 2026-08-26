/**
 * From a pile of files to a skill Alia will store, or a refusal with a reason.
 *
 * Every import path produces `RawFile[]` — a zip a person uploaded, a tarball
 * from GitHub, a directory on disk, or the single document the editor writes —
 * and then hands it here. This is the one place that decides what a bundle may
 * contain, so a limit stated once holds for all four.
 *
 * ## Path safety is decided here, in one comparison per rule
 *
 * A bundle is somebody else's archive, so its entry names are hostile input:
 * `../../etc/passwd`, `/etc/passwd`, `a\..\..\b`, a NUL byte, or a symlink
 * pointing out of the tree. None of them are sanitised into something safe —
 * they are refused, because a rewritten path is a path whose meaning nobody can
 * state afterwards. The schema repeats the same rule as a CHECK so the guarantee
 * survives a writer that forgets to come through here.
 *
 * ## Text is inlined, bytes go to S3
 *
 * A reference file is read on nearly every activation of the skill that bundles
 * it and is a couple of kilobytes, so it lives in Postgres and costs one query.
 * Anything binary, or text past `MAX_INLINE_BYTES`, is handed to the caller to
 * store in S3 instead — this module never writes to S3 itself, it only says
 * which files belong there.
 *
 * ## The root directory is discovered, not assumed
 *
 * Archives arrive as `skill-name/SKILL.md`, as `repo-sha/skills/x/SKILL.md`, or
 * flat. The directory holding `SKILL.md` is the skill's root and every other
 * path is taken relative to it; files outside it are not part of the skill and
 * are dropped rather than silently flattened into it.
 */

import { createHash } from 'node:crypto';
import type { SkillFileKind } from '../../domain/skill.js';
import { type ParseOptions, type ParsedSkillDocument, SkillSpecError, parseSkillDocument } from './spec.js';

/** Anthropic's Skills API refuses an upload past 30 MB uncompressed; matching it keeps skills portable. */
export const MAX_BUNDLE_BYTES = 30 * 1024 * 1024;
export const MAX_FILES = 200;
/** Past this, text is stored as an object rather than in a column. */
export const MAX_INLINE_BYTES = 256 * 1024;
/** The spec asks for under 500 lines; this is the hard stop, not the guidance. */
export const MAX_DOCUMENT_BYTES = 1024 * 1024;

export interface RawFile {
  /** As the archive names it, before any validation. */
  path: string;
  content: Buffer;
  /** POSIX mode when the source carries one, so an executable script stays one. */
  mode?: number;
  /** Symlinks are refused; the flag exists so tar and zip readers can report one. */
  symlink?: boolean;
}

export interface BundleFile {
  readonly path: string;
  readonly kind: SkillFileKind;
  readonly mime: string;
  readonly bytes: number;
  readonly sha256: string;
  readonly executable: boolean;
  /** Set when the file belongs in a column. Mutually exclusive with `content`. */
  readonly contentText?: string;
  /** Set when the file belongs in object storage. Mutually exclusive with `contentText`. */
  readonly content?: Buffer;
}

export interface SkillBundle {
  readonly document: ParsedSkillDocument;
  readonly directoryName: string;
  /** Everything except `SKILL.md`, whose body is on the version row. */
  readonly files: BundleFile[];
  readonly bytes: number;
  /** sha256 over the document and every file digest. Equal checksum, equal bundle, no new version. */
  readonly checksum: string;
  readonly warnings: string[];
}

export class SkillBundleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SkillBundleError';
  }
}

const TEXT_EXTENSIONS = new Map<string, string>([
  ['md', 'text/markdown'],
  ['markdown', 'text/markdown'],
  ['txt', 'text/plain'],
  ['csv', 'text/csv'],
  ['json', 'application/json'],
  ['yaml', 'application/yaml'],
  ['yml', 'application/yaml'],
  ['toml', 'application/toml'],
  ['xml', 'application/xml'],
  ['html', 'text/html'],
  ['css', 'text/css'],
  ['js', 'text/javascript'],
  ['mjs', 'text/javascript'],
  ['ts', 'text/typescript'],
  ['py', 'text/x-python'],
  ['rb', 'text/x-ruby'],
  ['sh', 'application/x-sh'],
  ['bash', 'application/x-sh'],
  ['sql', 'application/sql'],
]);

const BINARY_EXTENSIONS = new Map<string, string>([
  ['png', 'image/png'],
  ['jpg', 'image/jpeg'],
  ['jpeg', 'image/jpeg'],
  ['gif', 'image/gif'],
  ['webp', 'image/webp'],
  ['svg', 'image/svg+xml'],
  ['pdf', 'application/pdf'],
  ['zip', 'application/zip'],
  ['woff2', 'font/woff2'],
  ['ttf', 'font/ttf'],
  ['xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'],
  ['docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
  ['pptx', 'application/vnd.openxmlformats-officedocument.presentationml.presentation'],
]);

const SCRIPT_EXTENSIONS = new Set(['py', 'sh', 'bash', 'js', 'mjs', 'ts', 'rb']);

export const SKILL_DOCUMENT = 'SKILL.md';

/**
 * Split a repository tree into one entry per skill directory.
 *
 * A repository is rarely one skill: `anthropics/skills` holds dozens under
 * `skills/`, and a product repo bundles a handful under its own path. Each
 * `SKILL.md` found is a skill, and its directory is the root of that skill's
 * files — a file under a nested skill belongs to the nested one, not to both.
 */
export function splitSkillDirectories(files: RawFile[]): Map<string, RawFile[]> {
  const roots = files
    .filter((file) => normalisePath(file.path).endsWith(`/${SKILL_DOCUMENT}`) || normalisePath(file.path) === SKILL_DOCUMENT)
    .map((file) => directoryOf(normalisePath(file.path)))
    .sort((a, b) => b.length - a.length);

  const grouped = new Map<string, RawFile[]>();
  for (const root of roots) grouped.set(root, []);
  for (const file of files) {
    const path = normalisePath(file.path);
    const owner = roots.find((root) => (root === '' ? true : path.startsWith(`${root}/`)));
    if (owner === undefined) continue;
    grouped.get(owner)!.push({ ...file, path: owner === '' ? path : path.slice(owner.length + 1) });
  }
  return grouped;
}

export interface BuildOptions extends ParseOptions {
  /** The skill's directory name, when the archive did not carry one (a flat zip, the editor). */
  directoryName?: string;
}

export function buildSkillBundle(files: RawFile[], opts: BuildOptions = {}): SkillBundle {
  const document = files.find((file) => normalisePath(file.path) === SKILL_DOCUMENT);
  if (!document) throw new SkillBundleError(`the bundle has no ${SKILL_DOCUMENT} at its root`);
  if (document.content.byteLength > MAX_DOCUMENT_BYTES) {
    throw new SkillBundleError(`${SKILL_DOCUMENT} is larger than ${MAX_DOCUMENT_BYTES} bytes`);
  }

  const parsed = parseSkillDocument(document.content.toString('utf8'), {
    authored: opts.authored,
    directoryName: opts.directoryName,
  });
  const directoryName = opts.directoryName ?? parsed.frontmatter.name;
  const warnings = [...parsed.warnings];

  const bundled: BundleFile[] = [];
  let bytes = document.content.byteLength;

  for (const file of files) {
    const path = normalisePath(file.path);
    if (path === SKILL_DOCUMENT) continue;
    if (file.symlink) throw new SkillBundleError(`"${file.path}" is a symlink, which a skill may not bundle`);
    assertSafePath(file.path, path);

    bytes += file.content.byteLength;
    if (bytes > MAX_BUNDLE_BYTES) {
      throw new SkillBundleError(`the bundle is larger than ${MAX_BUNDLE_BYTES} bytes uncompressed`);
    }
    if (bundled.length + 1 > MAX_FILES) {
      throw new SkillBundleError(`the bundle holds more than ${MAX_FILES} files`);
    }

    bundled.push(describeFile(path, file));
  }

  bundled.sort((a, b) => (a.path < b.path ? -1 : 1));

  const digest = createHash('sha256');
  digest.update(document.content);
  for (const file of bundled) digest.update(`\n${file.path}:${file.sha256}`);

  return {
    document: parsed,
    directoryName,
    files: bundled,
    bytes,
    checksum: digest.digest('hex'),
    warnings,
  };
}

function describeFile(path: string, file: RawFile): BundleFile {
  const extension = path.includes('.') ? path.slice(path.lastIndexOf('.') + 1).toLowerCase() : '';
  const kind = classify(path, extension);
  const sha256 = createHash('sha256').update(file.content).digest('hex');
  const executable = kind === 'script' || (file.mode !== undefined && (file.mode & 0o111) !== 0);

  const textMime = TEXT_EXTENSIONS.get(extension);
  const inlinable = textMime !== undefined && file.content.byteLength <= MAX_INLINE_BYTES && isUtf8Text(file.content);
  if (inlinable) {
    return {
      path,
      kind,
      mime: textMime,
      bytes: file.content.byteLength,
      sha256,
      executable,
      contentText: file.content.toString('utf8'),
    };
  }

  return {
    path,
    kind,
    mime: textMime ?? BINARY_EXTENSIONS.get(extension) ?? 'application/octet-stream',
    bytes: file.content.byteLength,
    sha256,
    executable,
    content: file.content,
  };
}

/**
 * What a file is for.
 *
 * The spec's directories are a convention rather than a requirement, so the
 * directory decides when there is one and the extension decides when there is
 * not — a python file at the root of a skill is still a script, and refusing to
 * treat it as one would make it unreachable.
 */
function classify(path: string, extension: string): SkillFileKind {
  if (path.startsWith('scripts/')) return 'script';
  if (path.startsWith('references/') || path.startsWith('reference/')) return 'reference';
  if (path.startsWith('assets/')) return 'asset';
  if (SCRIPT_EXTENSIONS.has(extension)) return 'script';
  if (extension === 'md' || extension === 'markdown' || extension === 'txt') return 'reference';
  return 'asset';
}

/** Only cosmetic tidying — an unsafe path stays unsafe here, and `assertSafePath` refuses it. */
function normalisePath(path: string): string {
  return path.trim().replace(/^\.\//, '');
}

function directoryOf(path: string): string {
  const index = path.lastIndexOf('/');
  return index === -1 ? '' : path.slice(0, index);
}

function assertSafePath(original: string, path: string): void {
  if (path === '') throw new SkillBundleError('a bundled file has an empty path');
  if (path.startsWith('/')) throw new SkillBundleError(`"${original}" is an absolute path`);
  if (path.includes('\\')) throw new SkillBundleError(`"${original}" uses backslashes; skill paths are forward-slashed`);
  if (path.includes('\0')) throw new SkillBundleError('a bundled file path contains a null byte');
  if (path.split('/').some((segment) => segment === '..')) {
    throw new SkillBundleError(`"${original}" escapes the skill directory`);
  }
  if (/^[a-zA-Z]:/.test(path)) throw new SkillBundleError(`"${original}" is a Windows drive path`);
}

/** A NUL byte, or bytes that are not UTF-8, means this is not a file to put in a text column. */
function isUtf8Text(content: Buffer): boolean {
  if (content.includes(0)) return false;
  return Buffer.compare(Buffer.from(content.toString('utf8'), 'utf8'), content) === 0;
}

export { SkillSpecError };
