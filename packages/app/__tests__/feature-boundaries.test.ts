import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, posix, relative } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { APP_ROOT } from '@/shared/testing/app-root';

/**
 * The shape of `src/`, asserted rather than remembered (#608 §4,
 * `docs/app-architecture.mdx`).
 *
 * The app is `src/shell` (the frame every screen sits in), one folder per
 * feature under `src/features/<name>/{ui,runtime,model}`, and `src/shared/<layer>`
 * for what no feature owns. That layout is only worth having while imports
 * respect it: a feature that reaches into another's hooks "just this once" is
 * how `components/` and `lib/` became one knot, and it typechecks, renders and
 * reads fine in review. So every rule below is one a single import can break,
 * and each names the file and the specifier that broke it.
 *
 *  1. Every file under `src/` belongs to exactly one node: `shell`,
 *     `features/<x>` (inside `ui/`, `runtime/` or `model/`) or `shared/<y>`.
 *     There is no `src/app` — expo-router would take it for the routes.
 *  2. No two features import each other, directly or around a loop.
 *  3. A feature imports another only along an edge in {@link ALLOWED}; a new
 *     edge is added there deliberately, and one that is no longer used is
 *     removed, so the list is the graph and not a wish.
 *  4. `shared/` imports no feature, no `shell/`, no route.
 *  5. `shared/ui` draws; it fetches nothing and holds no store.
 *  6. No feature imports the shell.
 *  7. Nothing in `src/` imports a route or a fixture, and only tests import
 *     `shared/testing`.
 *  8. The old layout is gone: no `components/`, `lib/`, `types/` or `test/`
 *     directory, and no specifier naming one.
 *
 * Tests (`__tests__/`) are exempt from 2–6: a test may mount whatever it needs.
 * How Bloom is reached is `bloom-boundaries.test.ts`, beside this one.
 *
 * Specifiers are read with the TypeScript parser, type-only ones included: a
 * `import type` cycle costs nothing at runtime and everything to the next
 * person who has to move one of the two files.
 */

/** Feature → the features it may import. Anything not here imports only `shared/`. */
const ALLOWED: Record<string, readonly string[]> = {
  shell: ['agents', 'chat', 'library', 'notifications', 'onboarding', 'projects', 'settings'],
  settings: ['billing', 'chat', 'connections', 'library', 'local-models', 'memory'],
  automations: ['agents', 'chat'],
  agents: ['chat', 'library'],
  chat: [
    'billing', 'connections', 'library', 'local-models', 'memory', 'notifications', 'projects',
    'research', 'skills', 'voice',
  ],
  voice: ['memory'],
  shows: ['notifications'],
};

/** What `shared/ui` may not reach: it renders what it is handed. */
const UI_MAY_NOT_IMPORT = [/^@\/shared\/api(\/|$)/, /^@tanstack\/react-query/, /^socket\.io-client/, /^zustand/];

const OLD_LAYOUT = ['components', 'lib', 'types', 'test'];
const LAYERS = new Set(['ui', 'runtime', 'model']);

interface SourceFile {
  /** Relative to `packages/app`, `/`-separated. */
  path: string;
  source: string;
}

/** Every module specifier in a file: imports, re-exports, `import()`, `import("…")` types, `require`, `vi.mock`. */
function specifiers(file: SourceFile): string[] {
  const kind = file.path.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const sf = ts.createSourceFile(file.path, file.source, ts.ScriptTarget.Latest, true, kind);
  const found: string[] = [];
  const visit = (node: ts.Node): void => {
    let spec: ts.Node | undefined;
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier) {
      spec = node.moduleSpecifier;
    } else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)) {
      spec = node.argument.literal;
    } else if (ts.isCallExpression(node) && node.arguments.length > 0) {
      const callee = node.expression;
      if (
        callee.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(callee) && callee.text === 'require') ||
        (ts.isPropertyAccessExpression(callee) &&
          ts.isIdentifier(callee.expression) &&
          callee.expression.text === 'vi' &&
          /^(mock|doMock|unmock|doUnmock|importActual|importMock)$/.test(callee.name.text))
      ) {
        spec = node.arguments[0];
      }
    }
    if (spec && ts.isStringLiteralLike(spec)) found.push(spec.text);
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return found;
}

/** The package-relative path a specifier names, or `undefined` for a package import. */
function target(from: string, spec: string): string | undefined {
  if (spec.startsWith('@/')) return `src/${spec.slice(2)}`;
  if (spec.startsWith('./') || spec.startsWith('../')) return posix.normalize(posix.join(posix.dirname(from), spec));
  return undefined;
}

type Node = { kind: 'shell' } | { kind: 'feature'; name: string } | { kind: 'shared'; name: string } | { kind: 'app' | 'fixtures' | 'other' };

function nodeOf(path: string): Node | undefined {
  const parts = path.split('/');
  if (parts[0] !== 'src') {
    if (parts[0] === 'app') return { kind: 'app' };
    if (parts[0] === 'fixtures') return { kind: 'fixtures' };
    return { kind: 'other' };
  }
  if (parts[1] === 'shell' && parts.length > 2) return { kind: 'shell' };
  if (parts[1] === 'features' && parts.length > 4 && LAYERS.has(parts[3])) return { kind: 'feature', name: parts[2] };
  if (parts[1] === 'shared' && parts.length > 3) return { kind: 'shared', name: parts[2] };
  return undefined;
}

const graphName = (node: Node | undefined): string | undefined =>
  node?.kind === 'shell' ? 'shell' : node?.kind === 'feature' ? node.name : undefined;

const isTest = (path: string) => path.includes('/__tests__/') || path.startsWith('__tests__/');

/** Strongly connected components with more than one member (Tarjan). */
function cycles(graph: Map<string, Set<string>>): string[][] {
  let index = 0;
  const indices = new Map<string, number>();
  const low = new Map<string, number>();
  const stack: string[] = [];
  const onStack = new Set<string>();
  const out: string[][] = [];
  const connect = (v: string): void => {
    indices.set(v, index);
    low.set(v, index);
    index += 1;
    stack.push(v);
    onStack.add(v);
    for (const w of graph.get(v) ?? []) {
      if (!indices.has(w)) {
        connect(w);
        low.set(v, Math.min(low.get(v)!, low.get(w)!));
      } else if (onStack.has(w)) {
        low.set(v, Math.min(low.get(v)!, indices.get(w)!));
      }
    }
    if (low.get(v) === indices.get(v)) {
      const component: string[] = [];
      let w: string;
      do {
        w = stack.pop()!;
        onStack.delete(w);
        component.push(w);
      } while (w !== v);
      if (component.length > 1) out.push(component.sort());
    }
  };
  for (const v of graph.keys()) if (!indices.has(v)) connect(v);
  return out;
}

/** Every broken rule, as one line each. Empty means the tree is the shape it claims. */
function violations(files: readonly SourceFile[], allowed: Record<string, readonly string[]>): string[] {
  const found: string[] = [];
  const graph = new Map<string, Set<string>>();
  const witness = new Map<string, string>();

  for (const file of files) {
    const from = nodeOf(file.path);
    if (file.path.startsWith('src/app/')) found.push(`[1] ${file.path}: src/app is expo-router's routes directory`);
    else if (!from) found.push(`[1] ${file.path}: not inside src/shell, src/features/<x>/{ui,runtime,model} or src/shared/<y>`);
    const fromName = graphName(from);
    if (fromName) graph.set(fromName, graph.get(fromName) ?? new Set());

    for (const spec of specifiers(file)) {
      const path = target(file.path, spec);
      if (path === undefined) {
        if (from?.kind === 'shared' && from.name === 'ui' && !isTest(file.path) && UI_MAY_NOT_IMPORT.some((re) => re.test(spec))) {
          found.push(`[5] ${file.path}: shared/ui imports '${spec}'`);
        }
        continue;
      }
      const at = `${file.path}: '${spec}'`;
      if (OLD_LAYOUT.some((dir) => path === dir || path.startsWith(`${dir}/`) || path === `src/${dir}` || path.startsWith(`src/${dir}/`))) {
        found.push(`[8] ${at} names the old layout`);
        continue;
      }
      if (isTest(file.path) || !from || from.kind === 'app' || from.kind === 'fixtures' || from.kind === 'other') continue;

      const to = nodeOf(path);
      if (to?.kind === 'app' || to?.kind === 'fixtures') found.push(`[7] ${at} imports ${to.kind === 'app' ? 'a route' : 'a fixture'}`);
      if (to?.kind === 'shared' && to.name === 'testing') found.push(`[7] ${at} imports shared/testing outside a test`);
      if (from.kind === 'shared') {
        if (to?.kind === 'feature' || to?.kind === 'shell') found.push(`[4] ${at}: shared imports ${to.kind === 'shell' ? 'the shell' : `features/${to.name}`}`);
        if (from.name === 'ui' && to?.kind === 'shared' && to.name === 'api') found.push(`[5] ${at}: shared/ui imports shared/api`);
        continue;
      }
      if (from.kind === 'feature' && to?.kind === 'shell') {
        found.push(`[6] ${at}: a feature imports the shell`);
        continue;
      }
      const toName = graphName(to);
      if (fromName && toName && fromName !== toName) {
        graph.get(fromName)!.add(toName);
        const edge = `${fromName} -> ${toName}`;
        if (!witness.has(edge)) witness.set(edge, at);
        if (!(allowed[fromName] ?? []).includes(toName)) {
          found.push(`[3] ${at}: ${edge} is not an allowed edge — add it to ALLOWED deliberately, or import a shared contract instead`);
        }
      }
    }
  }

  for (const component of cycles(graph)) {
    const edges = [...witness].filter(([edge]) => {
      const [a, b] = edge.split(' -> ');
      return component.includes(a) && component.includes(b);
    });
    found.push(`[2] cycle between ${component.join(', ')}: ${edges.map(([edge, at]) => `${edge} (${at})`).join('; ')}`);
  }
  for (const [from, tos] of Object.entries(allowed)) {
    for (const to of tos) {
      if (!graph.get(from)?.has(to)) found.push(`[3] ALLOWED lists ${from} -> ${to}, which nothing imports any more — remove it`);
    }
  }
  return found;
}

function readTree(): SourceFile[] {
  const files: SourceFile[] = [];
  const walk = (dir: string): void => {
    if (!existsSync(dir)) return;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (/\.tsx?$/.test(entry.name) && !entry.name.endsWith('.d.ts')) {
        files.push({ path: relative(APP_ROOT, path).split('\\').join('/'), source: readFileSync(path, 'utf8') });
      }
    }
  };
  for (const dir of ['src', 'app', 'fixtures', '__tests__']) walk(join(APP_ROOT, dir));
  return files;
}

describe('the feature tree', () => {
  const tree = readTree();

  it('read the app, so an empty tree cannot pass as a clean one', () => {
    expect(tree.filter((f) => f.path.startsWith('src/features/')).length).toBeGreaterThan(200);
    expect(tree.filter((f) => f.path.startsWith('app/')).length).toBeGreaterThan(40);
  });

  it('breaks none of the rules', () => {
    expect(violations(tree, ALLOWED)).toEqual([]);
  });

  it('has no old layout directory and no src/app', () => {
    for (const dir of [...OLD_LAYOUT, 'src/app']) expect(existsSync(join(APP_ROOT, dir)), dir).toBe(false);
  });

  it('allows no cycle in the list itself', () => {
    const graph = new Map(Object.entries(ALLOWED).map(([k, v]) => [k, new Set(v)]));
    expect(cycles(graph)).toEqual([]);
  });
});

/**
 * The same checks against trees built to break them, one rule each: a gate
 * that cannot fail is a gate that proves nothing.
 */
describe('the gate catches', () => {
  const file = (path: string, ...imports: string[]): SourceFile => ({
    path,
    source: imports.map((spec, i) => `import x${i} from '${spec}';`).join('\n'),
  });
  const rules = (files: SourceFile[], allowed: Record<string, readonly string[]> = {}) =>
    violations(files, allowed).map((line) => line.slice(0, 3));

  it('[1] a file outside every node, and src/app', () => {
    expect(rules([file('src/helpers.ts')])).toEqual(['[1]']);
    expect(rules([file('src/features/chat/composer.tsx')])).toEqual(['[1]']);
    expect(rules([file('src/app/index.tsx')])).toEqual(['[1]']);
  });

  it('[2] a cycle, even between allowed edges', () => {
    const files = [
      file('src/features/a/ui/x.tsx', '@/features/b/model/y'),
      file('src/features/b/model/y.ts', '../../a/ui/x'),
    ];
    expect(rules(files, { a: ['b'], b: ['a'] })).toEqual(['[2]']);
  });

  it('[2] a type-only cycle', () => {
    const files = [
      { path: 'src/features/a/model/t.ts', source: "import type { B } from '@/features/b/model/t';" },
      { path: 'src/features/b/model/t.ts', source: "export type { A } from '@/features/a/model/t';" },
    ];
    expect(rules(files, { a: ['b'], b: ['a'] })).toEqual(['[2]']);
  });

  it('[3] an edge nobody allowed, and an allowed edge nobody uses', () => {
    expect(rules([file('src/features/a/ui/x.tsx', '@/features/b/ui/y')])).toEqual(['[3]']);
    expect(rules([file('src/features/a/ui/x.tsx')], { a: ['b'] })).toEqual(['[3]']);
  });

  it('[4] shared reaching up', () => {
    expect(rules([file('src/shared/format/x.ts', '@/features/chat/model/y')])).toEqual(['[4]']);
    expect(rules([file('src/shared/format/x.ts', '@/shell/sidebar')])).toEqual(['[4]']);
  });

  it('[5] shared/ui fetching or holding state', () => {
    expect(rules([file('src/shared/ui/x.tsx', 'zustand')])).toEqual(['[5]']);
    expect(rules([file('src/shared/ui/x.tsx', '@tanstack/react-query')])).toEqual(['[5]']);
    expect(rules([file('src/shared/ui/x.tsx', '@/shared/api/client')])).toEqual(['[5]']);
  });

  it('[6] a feature importing the shell', () => {
    expect(rules([file('src/features/chat/ui/x.tsx', '@/shell/sidebar')])).toEqual(['[6]']);
  });

  it('[7] src importing a route, a fixture or test scaffolding', () => {
    expect(rules([file('src/features/chat/ui/x.tsx', '../../../../app/(app)/index')])).toEqual(['[7]']);
    expect(rules([file('src/shared/api/x.ts', '../../../fixtures/conversation')])).toEqual(['[7]']);
    expect(rules([file('src/features/chat/ui/x.tsx', '@/shared/testing/translate')])).toEqual(['[7]']);
  });

  it('[8] a specifier naming the old layout, from anywhere', () => {
    expect(rules([file('app/index.tsx', '@/lib/hooks/use-translation')])).toEqual(['[8]']);
    expect(rules([{ path: 'src/features/chat/ui/__tests__/x.test.ts', source: "vi.mock('@/components/sidebar');" }])).toEqual(['[8]']);
    expect(rules([file('__tests__/x.test.ts', '../components/sidebar')])).toEqual(['[8]']);
  });

  it('and lets a test mount whatever it needs', () => {
    expect(rules([file('src/features/chat/ui/__tests__/x.test.tsx', '@/features/agents/ui/y', '@/shell/sidebar')])).toEqual([]);
  });
});
