/**
 * The console does not ask Alia to issue a developer application or a key.
 *
 * #160 closed every creation path in the API: `POST /developer/apps` and
 * `POST /developer/apps/:appId/keys` answer `410 Gone` with
 * `{ error: "issuance_closed" }`. This suite is the console half — it fails if a
 * screen or store starts calling one of them again.
 *
 * ## Why this file exists at all
 *
 * `docs/migration/epic-139-status.json` row 459 names the gap plainly: "No CI
 * job covers packages/alia-console today; the deliverable includes adding one,
 * or a content census from the API suite. Naming that gap is required — a screen
 * deletion with no job that would notice its return is not gated."
 *
 * Before this PR the console had a `test` script of `vitest run
 * --passWithNoTests` and zero test files, which is a green that measures
 * nothing, and no workflow ran it. This is the first real test in the package,
 * and `.github/workflows/ci.yml` now runs the package's `typecheck` and `test`.
 *
 * ## Why a source census rather than a rendering test
 *
 * The property is "no code path asks for issuance", and that is a property of
 * the whole package, not of one component. A render test of the two screens I
 * changed would pass forever while a third screen grew a create button. The
 * census reads every shipped module instead.
 *
 * It is deliberately NOT a `grep`: `grep` is line-based, so a call split across
 * lines reads as absent, and a commented-out example reads as present — and the
 * comments in `use-developer.ts` discuss `useCreateApiKey` at length precisely
 * because it was deleted. Comments are trivia to the parser, so they cannot
 * satisfy or trip this.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const SRC = fileURLToPath(new URL('../', import.meta.url));

function shippedModules(): Array<string> {
  const out: Array<string> = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === '__tests__' || entry.name === 'node_modules') continue;
        walk(full);
        continue;
      }
      if (!/\.tsx?$/.test(entry.name) || entry.name.endsWith('.test.ts')) continue;
      out.push(full);
    }
  };
  walk(SRC);
  return out;
}

/**
 * Every piece of text a source states literally: string literals, template
 * literal spans, and JSX text.
 *
 * A template is what the key route is built with — `` `/developer/apps/${appId}/keys` ``
 * — so reading only plain strings would miss the exact call this guards. The
 * template's literal SPANS are what get matched, so an interpolation is simply
 * a gap between two of them.
 *
 * **`ts.JsxText` is here because leaving it out made the rotation census
 * useless, and the census still passed.** A button label is written as JSX text
 * — `<Button>Rotate key</Button>` — which is not a `StringLiteral` and never
 * reaches a walker that only collects those. Measured: with JSX text excluded,
 * planting exactly that button left all eight tests green. A guard that cannot
 * see the most natural way to write the thing it forbids is decoration.
 */
function literalText(file: string, source: string): Array<string> {
  const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  const out: Array<string> = [];
  const visit = (node: ts.Node): void => {
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
      out.push(node.text);
    } else if (ts.isTemplateExpression(node)) {
      out.push(node.head.text);
      for (const span of node.templateSpans) out.push(span.literal.text);
    } else if (ts.isJsxText(node)) {
      out.push(node.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(ast);
  return out;
}

/** `apiClient.post(...)` / `.patch(...)` etc., paired with the literals of the first argument. */
interface Request {
  readonly file: string;
  readonly method: string;
  readonly path: string;
}

function requestsIn(file: string, source: string): Array<Request> {
  const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  const out: Array<Request> = [];
  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      ['get', 'post', 'patch', 'put', 'delete'].includes(node.expression.name.text) &&
      node.arguments.length > 0
    ) {
      const target = node.arguments[0];
      for (const literal of literalText(file, target.getText(ast))) {
        if (literal.startsWith('/')) {
          out.push({ file, method: node.expression.name.text, path: literal });
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(ast);
  return out;
}

const MODULES = shippedModules().map((file) => ({ file, source: readFileSync(file, 'utf8') }));

/**
 * User-visible copy offering to replace a credential.
 *
 * The verb must be followed by a credential noun. `rotate-90` fails because a
 * hyphen and a digit are not " key"; "Rotate key" passes.
 */
const ROTATION_COPY = /\b(rotat\w*|regenerat\w*|roll)\b[^.]{0,30}?\b(key|keys|secret|credential|credentials)\b/i;

describe('the census can see the console', () => {
  it('read a real corpus', () => {
    // The vacuity floor. An empty corpus satisfies every assertion below, and
    // "I found less" and "there is less" look identical without this.
    expect(MODULES.length).toBeGreaterThanOrEqual(50);
    const names = MODULES.map((m) => relative(SRC, m.file));
    expect(names).toContain('hooks/use-developer.ts');
    expect(names).toContain('routes/_layout/apps/index.tsx');
  });

  it('finds the requests the console DOES make', () => {
    // The positive control over the real tree: the walk reaches real call sites,
    // so a zero in the next block means absence rather than a broken walk.
    const all = MODULES.flatMap(({ file, source }) => requestsIn(file, source));
    expect(all.length).toBeGreaterThanOrEqual(8);
    expect(all.some((r) => r.method === 'get' && r.path === '/developer/apps')).toBe(true);
    expect(all.some((r) => r.method === 'delete')).toBe(true);
  });

  it('has a detector that fires on the exact shapes it guards, and ignores comments', () => {
    // The synthetic control. The tree is expected to be clean, so it can prove
    // nothing about the detector; a detector broken by a parser upgrade reports
    // the same clean zero as a correct one.
    expect(
      requestsIn('synthetic.ts', "await apiClient.post('/developer/apps', data);"),
    ).toEqual([{ file: 'synthetic.ts', method: 'post', path: '/developer/apps' }]);

    // The template form, which is how the key route is written. Both literal
    // SPANS surface — the interpolation is simply the gap between them — and the
    // head span is the one the prefix match below keys on.
    expect(
      requestsIn('synthetic.ts', 'await apiClient.post(`/developer/apps/${id}/keys`, d);').map(
        (r) => r.path,
      ),
    ).toEqual(['/developer/apps/', '/keys']);

    // Prose about it is invisible.
    expect(requestsIn('synthetic.ts', "// apiClient.post('/developer/apps')\nconst x = 1;")).toEqual([]);
  });
});

describe('the console asks Alia to issue nothing', () => {
  it('never POSTs to a closed creation path', () => {
    const offenders = MODULES.flatMap(({ file, source }) => requestsIn(file, source))
      .filter(
        (r) =>
          r.method === 'post' &&
          (r.path === '/developer/apps' || r.path.startsWith('/developer/apps/')),
      )
      .map((r) => `${relative(SRC, r.file)} ${r.method.toUpperCase()} ${r.path}`);
    expect(offenders).toEqual([]);
  });

  it('never calls the closed desktop authorization routes either', () => {
    // `/auth/token` and `/auth/authorize/*` were the second minting path #160
    // closed. The console has never called them; asserting it keeps that true
    // costs one line and the alternative is discovering it from a 410 in prod.
    const offenders = MODULES.flatMap(({ file, source }) => requestsIn(file, source))
      .filter((r) => r.path === '/auth/token' || r.path.startsWith('/auth/authorize'))
      .map((r) => `${relative(SRC, r.file)} ${r.path}`);
    expect(offenders).toEqual([]);
  });

  it('exports no creation hook', () => {
    // The store's own surface. A hook can exist unused for a release and then be
    // wired up by someone who assumes it works, so the absence is asserted at
    // the export rather than at the call site.
    const store = MODULES.find(({ file }) => relative(SRC, file) === 'hooks/use-developer.ts');
    expect(store).toBeDefined();
    const ast = ts.createSourceFile('use-developer.ts', store!.source, ts.ScriptTarget.Latest, true);
    const exported: Array<string> = [];
    ts.forEachChild(ast, (node) => {
      if (
        ts.isFunctionDeclaration(node) &&
        node.name !== undefined &&
        node.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)
      ) {
        exported.push(node.name.text);
      }
    });

    // Positive control: the walk found the survivors.
    expect(exported).toContain('useApps');
    expect(exported).toContain('useDeleteApiKey');
    expect(exported).toContain('useUpdateApiKey');

    expect(exported).not.toContain('useCreateApp');
    expect(exported).not.toContain('useCreateApiKey');
  });

  it('offers no control for a capability that does not exist', () => {
    /**
     * Rotation. No endpoint has ever regenerated an `alia_sk_*` secret in place
     * — measured during #160, and `compatibility-window.md` was corrected where
     * it claimed otherwise. `epic-139-status.json` row 459 still says to keep
     * "rotate and revoke", so this assertion is what stops a future reader
     * building the button that row implies.
     *
     * The pattern is deliberately narrow. A bare `/rotat/` matches Tailwind's
     * `rotate-90`, `rotate-45` and `rotate-180`, which five layout components
     * legitimately use — measured, it reported all five and would have reported
     * them forever. A census that fires on the wrong thing gets deleted by the
     * next person to see it, so it is scoped to rotation OF A CREDENTIAL, and
     * the control below proves it still fires on the real wording.
     */
    const offenders = MODULES.filter(({ file, source }) =>
      literalText(file, source).some((text) => ROTATION_COPY.test(text)),
    ).map(({ file }) => relative(SRC, file));
    expect(offenders).toEqual([]);
  });

  it('has a rotation detector that fires on real copy and not on a CSS transform', () => {
    // Including the JSX-text form, which is how a button label is actually
    // written and which an earlier version of this file could not see at all.
    expect(
      literalText('synthetic.tsx', '<Button>Rotate key</Button>').some((t) => ROTATION_COPY.test(t)),
    ).toBe(true);
    expect(
      literalText('synthetic.tsx', '<div className="rotate-90" />').some((t) => ROTATION_COPY.test(t)),
    ).toBe(false);

    for (const copy of [
      'Rotate key',
      'rotate your API keys',
      'Regenerate this key',
      'regenerate the credential',
      'Roll the secret',
    ]) {
      expect(ROTATION_COPY.test(copy)).toBe(true);
    }
    // The false positives that made the first version of this useless.
    for (const css of ['rotate-90', 'group-data-[state=open]:rotate-180', 'size-2.5 rotate-45']) {
      expect(ROTATION_COPY.test(css)).toBe(false);
    }
  });
});
