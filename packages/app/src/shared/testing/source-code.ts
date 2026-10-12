import { readFileSync } from 'node:fs';
import ts from 'typescript';

/**
 * A formatting-independent view of TypeScript source, for the tests that pin a
 * piece of code by reading it as text.
 *
 * Those tests used to match the raw file, so the formatter could break them by
 * re-quoting a string, wrapping a call or adding a trailing comma, and the files
 * they read had to be kept out of `biome format`. Here both sides of a match go
 * through one canonical form instead:
 *
 * - comments are dropped (they are trivia to the scanner), so a census cannot
 *   read the prose that explains it;
 * - whitespace is dropped, except one space between two word tokens
 *   (`const x`, `return await`), where it is part of the meaning;
 * - every string literal is re-quoted with single quotes;
 * - a trailing comma before `)`, `]`, `}` or `>` is dropped.
 *
 * Parentheses are tokens and stay. The formatter removes redundant ones (around
 * a ternary's test, say), so write a snippet without them.
 *
 * So `expect(codeOfFile(f)).toContain(snippet("router.use('/v1', cors({ origin: '*' }))"))`
 * holds however the file is wrapped, and a regex is written against the compact
 * form: `/router\.post\('\/',[^)]*apiKeyRateLimit/`.
 *
 * The same module as `packages/api/src/__tests__/support/source-code.ts`; the
 * packages share no test code, so each carries its copy and its own agreement
 * test (`./__tests__/source-code.test.ts` here).
 *
 * A FILE is read with the parser, which knows a regex literal from a division
 * and JSX text from code. A SNIPPET is usually a fragment the parser would
 * repair or drop tokens from, so it is read with the scanner. The two must agree
 * on whole files, and the agreement test proves they do on every file a
 * source-reading test pins.
 */

const WORD_EDGE_END = /[\w$]$/;
const WORD_EDGE_START = /^[\w$]/;
const CLOSERS = new Set([')', ']', '}', '>']);

function quote(value: string): string {
  return `'${value.replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\n/g, '\\n')}'`;
}

function join(tokens: readonly string[]): string {
  let out = '';
  let previous = '';
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (token === ',' && CLOSERS.has(tokens[i + 1] ?? '')) continue;
    if (WORD_EDGE_END.test(previous) && WORD_EDGE_START.test(token)) out += ' ';
    out += token;
    previous = token;
  }
  return out;
}

/** Canonical form of a whole source file's text, tokenised by the parser. */
export function canonicalSource(text: string, fileName = 'source.tsx'): string {
  const source = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true);
  const tokens: string[] = [];
  const visit = (node: ts.Node): void => {
    if (node.kind >= ts.SyntaxKind.FirstJSDocNode && node.kind <= ts.SyntaxKind.LastJSDocNode) {
      return;
    }
    const children = node.getChildren(source);
    if (children.length > 0) {
      for (const child of children) visit(child);
      return;
    }
    if (ts.isStringLiteral(node)) {
      tokens.push(quote(node.text));
      return;
    }
    const text = ts.isJsxText(node) ? node.text.replace(/\s+/g, ' ').trim() : node.getText(source);
    if (text !== '') tokens.push(text);
  };
  visit(source);
  return join(tokens);
}

/** Canonical form of the file at `absolutePath`. */
export function codeOfFile(absolutePath: string): string {
  return canonicalSource(readFileSync(absolutePath, 'utf8'), absolutePath);
}

/** Tokens after which a `/` divides; after anything else it opens a regex. */
const ENDS_AN_OPERAND = new Set<ts.SyntaxKind>([
  ts.SyntaxKind.Identifier,
  ts.SyntaxKind.PrivateIdentifier,
  ts.SyntaxKind.NumericLiteral,
  ts.SyntaxKind.BigIntLiteral,
  ts.SyntaxKind.StringLiteral,
  ts.SyntaxKind.RegularExpressionLiteral,
  ts.SyntaxKind.NoSubstitutionTemplateLiteral,
  ts.SyntaxKind.TemplateTail,
  ts.SyntaxKind.CloseParenToken,
  ts.SyntaxKind.CloseBracketToken,
  ts.SyntaxKind.CloseBraceToken,
  ts.SyntaxKind.ThisKeyword,
  ts.SyntaxKind.SuperKeyword,
  ts.SyntaxKind.TrueKeyword,
  ts.SyntaxKind.FalseKeyword,
  ts.SyntaxKind.NullKeyword,
]);

/**
 * Canonical form of a code snippet, which may be a fragment
 * (`.catch((err: unknown) => {`). Tokenised by the scanner, so it does not
 * understand JSX text; a snippet is code, not markup.
 */
export function snippet(text: string): string {
  const scanner = ts.createScanner(ts.ScriptTarget.Latest, true, ts.LanguageVariant.Standard, text);
  const tokens: string[] = [];
  // `template` marks a `${` whose `}` resumes the template it came from.
  const braces: ('block' | 'template')[] = [];
  let previous: ts.SyntaxKind | undefined;
  for (let kind = scanner.scan(); kind !== ts.SyntaxKind.EndOfFileToken; kind = scanner.scan()) {
    if (kind === ts.SyntaxKind.CloseBraceToken && braces.at(-1) === 'template') {
      braces.pop();
      kind = scanner.reScanTemplateToken(false);
    } else if (kind === ts.SyntaxKind.CloseBraceToken) {
      braces.pop();
    } else if (kind === ts.SyntaxKind.OpenBraceToken) {
      braces.push('block');
    } else if (
      (kind === ts.SyntaxKind.SlashToken || kind === ts.SyntaxKind.SlashEqualsToken) &&
      (previous === undefined || !ENDS_AN_OPERAND.has(previous))
    ) {
      kind = scanner.reScanSlashToken();
    }
    if (kind === ts.SyntaxKind.TemplateHead || kind === ts.SyntaxKind.TemplateMiddle) {
      braces.push('template');
    }
    tokens.push(
      kind === ts.SyntaxKind.StringLiteral
        ? quote(scanner.getTokenValue())
        : scanner.getTokenText(),
    );
    previous = kind;
  }
  return join(tokens);
}
