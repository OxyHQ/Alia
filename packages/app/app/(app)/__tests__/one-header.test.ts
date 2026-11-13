import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Every screen has ONE header.
 *
 * The layout draws the shell's container and header around every screen except those in the
 * `(own-header)` route group, which draw their own frame: a chat composes its own `AiChatContainer`
 * (its header is the conversation's, and the container holds the composer). A screen that draws a
 * frame outside the group gets the shell's header on top of its own — Gemies shipped `/agents/<id>`
 * that way, because its layout kept a hand-written list of route names and the new screen was not
 * in it.
 *
 * So this does not read a list: it reads every route file and follows what it RENDERS, through the
 * app's own modules and into `@gemies/sdk`, to whether it ends in an `AiChatContainer`. A screen that
 * does must be in the group, and one in the group must draw one (or it would have no frame at all).
 * A new screen is checked the moment its file exists.
 */
const here = dirname(fileURLToPath(import.meta.url));
const APP = resolve(here, '../../..');
const SRC = join(APP, 'src');
/** `@gemies/sdk` ships its sources; found the way node finds the package, up from the app. */
function sdkSource(): string {
  for (let dir = APP; dir !== dirname(dir); dir = dirname(dir)) {
    const candidate = join(dir, 'node_modules/@gemies/sdk/src');
    if (existsSync(candidate)) return candidate;
  }
  throw new Error('@gemies/sdk is not installed: run bun install');
}
const SDK_SRC = sdkSource();
const GROUP = '(own-header)';
const ROUTE_ROOTS = [join(APP, 'app/(app)'), join(APP, 'fixtures/routes/(app)')];

const read = (file: string) => readFileSync(file, 'utf8');

function walk(dir: string, keep: (file: string) => boolean): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return name === '__tests__' ? [] : walk(path, keep);
    return keep(path) ? [path] : [];
  });
}

/** JSX tags a module renders, by the name it renders them under (`<Foo.Bar` counts as `Foo`). */
const renderedTags = (source: string) =>
  new Set([...source.matchAll(/<([A-Z]\w*)[\s/>.]/g)].map((match) => match[1] ?? ''));

const FRAME = 'AiChatContainer';

/**
 * The SDK components that compose a frame (`GemieChatContent`), found by what their files render,
 * not named here: an SDK component that starts composing one is caught without editing this test.
 */
function sdkFrameComponents(): Set<string> {
  const files = walk(SDK_SRC, (file) => file.endsWith('.tsx')).map((file) => ({
    source: read(file),
    exports: [
      ...read(file).matchAll(/export\s+(?:default\s+)?(?:function|const)\s+([A-Z]\w*)/g),
    ].map((match) => match[1] ?? ''),
  }));
  const names = new Set<string>();
  let grew = true;
  while (grew) {
    grew = false;
    for (const { source, exports } of files) {
      const tags = renderedTags(source);
      if (!tags.has(FRAME) && ![...tags].some((tag) => names.has(tag))) continue;
      for (const name of exports) {
        if (!names.has(name)) {
          names.add(name);
          grew = true;
        }
      }
    }
  }
  return names;
}
const SDK_FRAMES = sdkFrameComponents();

const EXTENSIONS = ['.tsx', '.ts', '.web.tsx', '.native.tsx', '/index.tsx', '/index.ts'];

/** The app's own module a specifier names, or undefined for a package. */
function resolveLocal(from: string, specifier: string): string | undefined {
  const base = specifier.startsWith('@/')
    ? join(SRC, specifier.slice(2))
    : specifier.startsWith('.')
      ? resolve(dirname(from), specifier)
      : undefined;
  if (base === undefined) return undefined;
  for (const extension of ['', ...EXTENSIONS]) {
    const candidate = base + extension;
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
  }
  return undefined;
}

/** What each name a module imports (values, not types) comes from. */
function importedNames(source: string): Map<string, string> {
  const names = new Map<string, string>();
  for (const match of source.matchAll(/import\s+(?!type\s)([\s\S]*?)\s+from\s+['"]([^'"]+)['"]/g)) {
    const clause = match[1] ?? '';
    const specifier = match[2] ?? '';
    const defaultName = clause.match(/^([A-Za-z_$][\w$]*)/)?.[1];
    if (defaultName) names.set(defaultName, specifier);
    for (const part of clause.match(/\{([\s\S]*)\}/)?.[1]?.split(',') ?? []) {
      const binding = part.trim();
      if (binding === '' || binding.startsWith('type ')) continue;
      const local = binding
        .split(/\s+as\s+/)
        .pop()
        ?.trim();
      if (local) names.set(local, specifier);
    }
  }
  return names;
}

const memo = new Map<string, boolean>();

/** Whether rendering this module ends in a frame of its own: an `AiChatContainer`. */
function drawsFrame(file: string): boolean {
  const known = memo.get(file);
  if (known !== undefined) return known;
  memo.set(file, false); // a cycle draws nothing new
  const source = read(file);
  const imports = importedNames(source);
  const result = [...renderedTags(source)].some((tag) => {
    if (tag === FRAME) return true;
    const specifier = imports.get(tag);
    if (specifier === undefined) return false;
    if (specifier.startsWith('@gemies/sdk')) return SDK_FRAMES.has(tag);
    const local = resolveLocal(file, specifier);
    return local !== undefined && drawsFrame(local);
  });
  memo.set(file, result);
  return result;
}

const routes = ROUTE_ROOTS.filter(existsSync).flatMap((root) =>
  walk(
    root,
    (file) => file.endsWith('.tsx') && !file.split(sep).some((part) => part.startsWith('_layout')),
  ).map((file) => ({ file, route: relative(root, file).split(sep).join('/') })),
);

describe('one header on every screen', () => {
  it('finds the SDK chat that composes its own frame', () => {
    expect(SDK_FRAMES.has('GemieChatContent')).toBe(true);
  });

  it('reads the routes in and out of the group', () => {
    expect(routes.some(({ route }) => route.startsWith(`${GROUP}/`))).toBe(true);
    expect(routes.some(({ route }) => !route.startsWith(`${GROUP}/`))).toBe(true);
  });

  it.each(routes)(
    '$route draws its own frame exactly when it is in (own-header)',
    ({ file, route }) => {
      const inGroup = route.startsWith(`${GROUP}/`);
      const frame = drawsFrame(file);
      if (frame && !inGroup) {
        throw new Error(
          `${route} draws its own AiChatContainer but is outside ${GROUP}: the shell's header goes on top of its own. Move the file into app/(app)/${GROUP}/ (the URL does not change).`,
        );
      }
      if (!frame && inGroup) {
        throw new Error(
          `${route} is in ${GROUP} but draws no frame: the layout gives it none, so it has no header. Move it out of the group.`,
        );
      }
      expect(frame).toBe(inGroup);
    },
  );
});

describe('the layout', () => {
  const layout = read(join(APP, 'app/(app)/_layout.tsx'));

  it('keeps no list of route names to forget a screen in', () => {
    expect(layout).not.toMatch(/new Set\(\[/);
    expect(layout).toContain(`const OWN_HEADER_GROUP = '${GROUP}'`);
  });

  it('lets the group through bare, before it builds the shell header for the rest', () => {
    expect(layout).toMatch(/if \(drawsOwnHeader\(route\.name\)\) return children;/);
    expect(layout.indexOf('drawsOwnHeader(route.name)')).toBeLessThan(
      layout.indexOf('<ShellPageHeader'),
    );
  });
});
