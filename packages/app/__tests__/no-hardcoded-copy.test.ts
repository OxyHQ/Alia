import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

/**
 * Words a person reads go through `t()` (#608).
 *
 * Every string this app shows exists in `en.json` and `es.json`, and a Spanish
 * reader is shown the Spanish one. A literal in a component skips both: it is
 * English in every locale, and no catalog test can see it. The agent screens,
 * the automations, the invites and the execution panel's Activity tab all read
 * English in Spanish that way until this sweep.
 *
 * This reads every screen and component with the TypeScript parser — not a
 * regex, so a word in a comment, a className or a type is never a finding —
 * and fails on the places copy lives:
 *
 *  - JSX text: `<Text>Run now</Text>`;
 *  - a string literal handed to a prop a person reads or hears
 *    (`accessibilityLabel`, `placeholder`, `label`, `title`, …);
 *  - the text of a toast or an alert;
 *  - the `label`/`title`/`description` of an object literal — the dialog
 *    action, empty-state action and menu-item shape.
 *
 * What legitimately stays literal is a name that is the same in every language
 * (a brand, a product, a format) — the allowlist below, by exact string. It is
 * short on purpose: a new entry is a claim that the words are not words.
 */

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const DIRS = ['app', 'src'];

/** Files that are not rendered by React Native at all. */
const SKIPPED_FILES = new Set([
  // The static HTML shell Expo serves before the bundle loads: no runtime, no
  // locale, and its copy is SEO metadata for crawlers.
  'app/+html.tsx',
]);

/** Props whose string value is read or heard by a person. */
const COPY_PROPS = new Set([
  'accessibilityLabel',
  'accessibilityHint',
  'aria-label',
  'alt',
  'placeholder',
  'label',
  'title',
  'subtitle',
  'description',
  'hint',
  'message',
  'text',
  'content',
  'confirmLabel',
  'cancelLabel',
  'emptyText',
  'helperText',
  'tooltip',
]);

/** Object-literal keys that hold copy in the dialog/menu/action shapes. */
const COPY_KEYS = new Set(['label', 'title', 'description', 'confirmLabel', 'cancelLabel', 'accessibilityLabel', 'placeholder', 'message']);

/** Strings that are the same in every language. */
const ALLOWED = new Set([
  'Alia',
  'Alia \\ Oxy',
  'Syra',
  'Oxy',
  'Cowork',
  'iOS',
  'Android',
  'Apache-2.0',
  'YYYY-MM-DD',
  'https://example.com/mcp',
  'Authorization',
  'Bearer sk-...',
  'noindex, nofollow',
  'JSON',
  'CSV',
  '2min',
  // Messaging services, as their owners spell them.
  'WhatsApp',
  'Telegram',
  'Signal',
  'Gmail',
  // Languages, each named in itself: the picker must read the same whatever
  // language it is currently in, or nobody could find their way back.
  'English',
  'Español',
  'Français',
  'Deutsch',
  'Italiano',
  'Português',
  '中文',
  '日本語',
  '한국어',
  'Русский',
  'العربية',
]);

/**
 * Not words: an i18n key handed on to be translated where it is drawn
 * (`agents.archetype.qa.label`), or a URL.
 */
const NOT_COPY = /^([a-z][\w-]*(\.[\w-]+)+|https?:\/\/\S+)$/i;

/** A run of two letters: a word, as opposed to `·`, `—`, `+` or `09:00`. */
const WORDY = /\p{L}{2}/u;

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return name === '__tests__' ? [] : sourceFiles(path);
    return /\.tsx$/.test(name) && !/\.test\.tsx$/.test(name) ? [path] : [];
  });
}

/** The literal text of a string or template expression, placeholders removed. */
function literalText(node: ts.Node): string | null {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  if (ts.isTemplateExpression(node)) {
    return [node.head.text, ...node.templateSpans.map((span) => span.literal.text)].join(' ');
  }
  return null;
}

function isCopy(text: string | null): text is string {
  if (text === null) return false;
  const trimmed = text.trim();
  return trimmed !== '' && WORDY.test(trimmed) && !ALLOWED.has(trimmed) && !NOT_COPY.test(trimmed);
}

function findings(file: string): string[] {
  const source = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const found: string[] = [];
  const report = (node: ts.Node, text: string) => {
    const { line } = source.getLineAndCharacterOfPosition(node.getStart());
    found.push(`${relative(ROOT, file)}:${line + 1} ${JSON.stringify(text.trim().replace(/\s+/g, ' '))}`);
  };

  const visit = (node: ts.Node): void => {
    if (ts.isJsxText(node) && isCopy(node.text)) report(node, node.text);

    if (ts.isJsxExpression(node) && node.expression && (ts.isJsxElement(node.parent) || ts.isJsxFragment(node.parent))) {
      const text = literalText(node.expression);
      if (isCopy(text)) report(node, text);
    }

    if (ts.isJsxAttribute(node) && node.initializer && COPY_PROPS.has(node.name.getText(source))) {
      const init = node.initializer;
      const text = ts.isStringLiteral(init)
        ? init.text
        : ts.isJsxExpression(init) && init.expression
          ? literalText(init.expression)
          : null;
      if (isCopy(text)) report(node, text);
    }

    if (ts.isPropertyAssignment(node) && COPY_KEYS.has(node.name.getText(source))) {
      const text = literalText(node.initializer);
      if (isCopy(text)) report(node, text);
    }

    if (ts.isCallExpression(node) && node.arguments[0]) {
      const callee = node.expression.getText(source);
      if (/^(toast(\.\w+)?|Alert\.alert)$/.test(callee)) {
        const text = literalText(node.arguments[0]);
        if (isCopy(text)) report(node, text);
      }
    }

    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

const FILES = DIRS.flatMap((dir) => sourceFiles(join(ROOT, dir))).filter(
  (file) => !SKIPPED_FILES.has(relative(ROOT, file)),
);

describe('user-visible copy', () => {
  it('is read from every screen and component', () => {
    // Without this the assertion below passes over nothing.
    expect(FILES.length).toBeGreaterThan(150);
  });

  it('goes through t() rather than being written in English', () => {
    expect(FILES.flatMap(findings)).toEqual([]);
  });

  it('is caught in each place copy lives', () => {
    // A positive control per rule, so a parser change that silently stops
    // matching one of them fails here rather than passing everything.
    const probe = join(ROOT, '__tests__', '__probe__.tsx');
    const sample = [
      'const a = <Text>Run now</Text>;',
      'const b = <Button accessibilityLabel="Open menu" />;',
      "const c = toast.error('Could not save');",
      "const d = { label: 'Cancel' };",
      "const e = <Text>{`Show all ${n} steps`}</Text>;",
      'const f = <Text>Alia</Text>;',
      "const g = <View className=\"flex-row items-center\" testID=\"row\" />;",
      "const h = { label: 'agents.archetype.qa.label' };",
    ].join('\n');
    const source = ts.createSourceFile(probe, sample, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    const texts: string[] = [];
    const visit = (node: ts.Node): void => {
      if (ts.isJsxText(node) && isCopy(node.text)) texts.push(node.text.trim());
      if (ts.isJsxExpression(node) && node.expression && ts.isJsxElement(node.parent)) {
        const text = literalText(node.expression);
        if (isCopy(text)) texts.push(text.trim());
      }
      if (ts.isJsxAttribute(node) && node.initializer && COPY_PROPS.has(node.name.getText(source)) && ts.isStringLiteral(node.initializer) && isCopy(node.initializer.text)) {
        texts.push(node.initializer.text);
      }
      if (ts.isPropertyAssignment(node) && COPY_KEYS.has(node.name.getText(source))) {
        const text = literalText(node.initializer);
        if (isCopy(text)) texts.push(text);
      }
      if (ts.isCallExpression(node) && /^toast/.test(node.expression.getText(source))) {
        const text = literalText(node.arguments[0]!);
        if (isCopy(text)) texts.push(text);
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
    expect(texts).toEqual(['Run now', 'Open menu', 'Could not save', 'Cancel', 'Show all   steps']);
  });
});
