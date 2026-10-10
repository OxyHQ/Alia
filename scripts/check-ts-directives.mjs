/**
 * The half of ESLint's `@typescript-eslint/ban-ts-comment` that Biome cannot
 * express.
 *
 * Biome's `suspicious/noTsIgnore` covers the ignore directive. Nothing in Biome
 * 2.5.15 covers the other two the ESLint rule enforced here:
 *
 *   - the no-check pragma, which switches type checking off for a whole file;
 *   - the expect-error directive WITHOUT a description, which hides an error
 *     with no record of which error or why.
 *
 * A GritQL plugin cannot do it either: Biome's plugins match syntax nodes, and
 * comments are trivia attached to tokens, not nodes. Measured on 2.5.15: a regex
 * pattern over a statement whose leading comment carries the directive does not
 * match, and neither does one over the module root.
 *
 * So this reads every tracked JS/TS file, takes its comments from the
 * TypeScript parser (so a directive inside a string or template is not a
 * comment), and fails on either shape, repo-wide. A directive counts the way
 * TypeScript reads it: at the start of a line comment, or at the start of a
 * line inside a block comment. An expect-error's description is whatever
 * follows it on that line, less a leading `:` or `-`, and must be at least
 * three characters (typescript-eslint's default minimum).
 *
 *   node scripts/check-ts-directives.mjs [--root <dir>]
 *
 * `.github/scripts/test-check-ts-directives.mjs` proves it can still fail.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const args = process.argv.slice(2);
const rootFlag = args.indexOf('--root');
const ROOT =
  rootFlag === -1
    ? resolve(fileURLToPath(new URL('..', import.meta.url)))
    : resolve(args[rootFlag + 1]);

const EXTENSIONS = /\.(?:tsx|ts|mts|cts|jsx|js|mjs|cjs)$/;
const MIN_DESCRIPTION = 3;
// The directive at the start of a comment line. `\b` stops `@ts-nocheckers`.
const DIRECTIVE = /^\s*@ts-(nocheck|expect-error)\b(.*)$/;

const files = execFileSync('git', ['ls-files', '-z'], { cwd: ROOT, encoding: 'utf8' })
  .split('\0')
  .filter((file) => EXTENSIONS.test(file));

function scriptKind(file) {
  if (file.endsWith('.tsx')) return ts.ScriptKind.TSX;
  if (/\.[mc]?ts$/.test(file)) return ts.ScriptKind.TS;
  return ts.ScriptKind.JSX;
}

/** Every comment in the file, once, as `{ pos, end, kind }`. */
function comments(file, text) {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, scriptKind(file));
  const seen = new Map();
  const add = (ranges) => {
    for (const range of ranges ?? []) seen.set(range.pos, range);
  };
  const visit = (node) => {
    const children = node.getChildren(source);
    if (children.length === 0) {
      add(ts.getLeadingCommentRanges(text, node.getFullStart()));
      add(ts.getTrailingCommentRanges(text, node.getEnd()));
      return;
    }
    for (const child of children) visit(child);
  };
  visit(source);
  return { source, ranges: [...seen.values()] };
}

/** The directive lines of one comment: `[{ directive, description, offset }]`. */
function directives(text, range) {
  const raw = text.slice(range.pos, range.end);
  if (range.kind === ts.SyntaxKind.SingleLineCommentTrivia) {
    const match = DIRECTIVE.exec(raw.replace(/^\/\/+/, ''));
    return match ? [{ directive: match[1], description: match[2], offset: 0 }] : [];
  }
  const found = [];
  let offset = 0;
  for (const line of raw.replace(/\*\/$/, '').split('\n')) {
    const match = DIRECTIVE.exec(line.replace(/^\s*\/?\*+/, ''));
    if (match) found.push({ directive: match[1], description: match[2], offset });
    offset += line.length + 1;
  }
  return found;
}

const violations = [];
let mentioning = 0;
let directiveCount = 0;
for (const file of files) {
  const text = readFileSync(join(ROOT, file), 'utf8');
  if (!text.includes('@ts-')) continue;
  mentioning += 1;
  const { source, ranges } = comments(file, text);
  for (const range of ranges) {
    for (const { directive, description, offset } of directives(text, range)) {
      directiveCount += 1;
      const line = source.getLineAndCharacterOfPosition(range.pos + offset).line + 1;
      const where = `${file}:${line}`;
      if (directive === 'nocheck') {
        violations.push(`${where}  @ts-nocheck turns type checking off for the whole file`);
      } else if (description.replace(/^[\s:-]+/, '').trim().length < MIN_DESCRIPTION) {
        violations.push(
          `${where}  @ts-expect-error needs a description of at least ${MIN_DESCRIPTION} characters saying which error and why`,
        );
      }
    }
  }
}

console.log(
  `check-ts-directives: ${files.length} JS/TS files examined, ${mentioning} mention @ts-, ${directiveCount} directive comment(s).`,
);
if (files.length === 0) {
  console.error('check-ts-directives: no files to examine, so a clean result would mean nothing.');
  process.exit(1);
}
if (violations.length > 0) {
  for (const violation of violations) console.error(violation);
  process.exit(1);
}
console.log('check-ts-directives: clean.');
