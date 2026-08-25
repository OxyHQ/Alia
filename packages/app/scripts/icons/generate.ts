/**
 * Turns the symbols named in `manifest.ts` into one React component each.
 *
 * Run it with `bun run generate:icons` (from `packages/app`), which goes
 * through `write.ts`; this module only computes, so importing it — as the test
 * does — writes nothing.
 *
 * ## Why generated, and not hand-transcribed
 *
 * The icon components already in `components/ui` were each pasted by hand,
 * which is fine for one glyph and not for a set: a path is a kilobyte of
 * coordinates nobody can proofread, so a transcription slip is invisible until
 * it draws wrong. Generating them makes the committed art the source art by
 * construction, and `components/__tests__/generated-icons.test.ts` re-runs this
 * and diffs — so a hand-edit to the output, or a stale run, goes red.
 *
 * ## What it refuses to do
 *
 * - A fixed colour anywhere in a symbol aborts the run. `menu-badge` has a
 *   brand blue baked into it; taking it would put a hex in a tree whose rule is
 *   that colour comes from the scheme, and no theme could move it afterwards.
 * - Two manifest entries landing on one filename abort, because the second
 *   would silently overwrite the first.
 * - A symbol the manifest names but the sheet does not carry aborts, rather
 *   than emitting a component that draws nothing.
 *
 * ## The viewBox travels with the art
 *
 * The sheet mixes boxes: most symbols are `0 0 20 20`, the small chevrons are
 * `0 0 16 16`, the microphone is `0 0 24 24`. Each component carries its own
 * symbol's box, because 24-unit art rendered through a 20-unit box is cropped.
 * Nothing here normalises them.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ICONS, type IconEntry } from './manifest';

const HERE = fileURLToPath(new URL('.', import.meta.url));

export const SHEET = join(HERE, 'shell-sprites.svg');
export const OUT_DIR = join(HERE, '..', '..', 'components', 'ui', 'icons');

/** The sheet's whole vocabulary. Anything outside it means the input changed shape. */
const KNOWN_TAGS = new Set(['svg', 'symbol', 'g', 'path', 'circle']);

/** The presentation attributes that inherit, so a `<g>` can set them for its children. */
const INHERITED = [
  'fill',
  'stroke',
  'stroke-width',
  'stroke-linecap',
  'stroke-linejoin',
] as const;

/** SVG attribute -> the react-native-svg prop that carries it, for the string-valued ones. */
const STRING_PROPS = [
  ['stroke-linecap', 'strokeLinecap'],
  ['stroke-linejoin', 'strokeLinejoin'],
  ['fill-rule', 'fillRule'],
  ['clip-rule', 'clipRule'],
  ['transform', 'transform'],
] as const;

interface Element {
  tag: string;
  attrs: Record<string, string>;
  children: Element[];
}

/**
 * A tokenizer rather than an XML library.
 *
 * The sheet is one machine-written file with no text nodes, no CDATA, no
 * entities and no namespaces, and it is committed next to this script, so its
 * shape cannot drift under us; adding a parser dependency to the app package to
 * read one build-time asset is the larger cost. The guards are what make that
 * safe — an unknown tag, an unbalanced close, or any leftover markup throws
 * rather than parsing into something plausible.
 */
function parse(source: string): Element {
  const root: Element = { tag: '#root', attrs: {}, children: [] };
  const stack: Element[] = [root];
  const tagPattern = /<(\/?)([a-zA-Z][\w:-]*)((?:\s+[\w:-]+="[^"]*")*)\s*(\/?)>/g;

  let consumed = 0;
  let match: RegExpExecArray | null;
  while ((match = tagPattern.exec(source)) !== null) {
    const between = source.slice(consumed, match.index).trim();
    if (between.length > 0) throw new Error(`unexpected text in the sheet: ${between.slice(0, 40)}`);
    consumed = match.index + match[0].length;

    const [, closing, tag, rawAttrs, selfClosing] = match;
    if (!KNOWN_TAGS.has(tag)) throw new Error(`unknown tag <${tag}> in the sheet`);

    if (closing === '/') {
      const open = stack.pop();
      if (open === undefined || open.tag !== tag) throw new Error(`</${tag}> closes nothing`);
      continue;
    }

    const attrs: Record<string, string> = {};
    for (const attr of rawAttrs.matchAll(/([\w:-]+)="([^"]*)"/g)) attrs[attr[1]] = attr[2];

    const element: Element = { tag, attrs, children: [] };
    stack[stack.length - 1].children.push(element);
    if (selfClosing !== '/') stack.push(element);
  }

  const trailing = source.slice(consumed).trim();
  if (trailing.length > 0) throw new Error(`unexpected trailing markup: ${trailing.slice(0, 40)}`);
  if (stack.length !== 1) throw new Error(`${stack.length - 1} tag(s) left open in the sheet`);
  return root;
}

/** Every drawable leaf under `element`, each carrying what it inherited on the way down. */
function flatten(element: Element, inherited: Record<string, string>): Element[] {
  const own = { ...inherited };
  for (const key of INHERITED) {
    const value = element.attrs[key];
    if (value !== undefined) own[key] = value;
  }
  if (element.tag === 'path' || element.tag === 'circle') {
    return [{ tag: element.tag, attrs: { ...own, ...element.attrs }, children: [] }];
  }
  return element.children.flatMap((child) => flatten(child, own));
}

/** `AgentRobot` -> `agent-robot`. */
export function kebab(name: string): string {
  return name.replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase();
}

/**
 * The JSX for a colour slot.
 *
 * An absent `fill`/`stroke` means "inherit", which at a `<use>` site resolves to
 * whatever colour the caller set — so it and an explicit `currentColor` are the
 * same thing, and both become the component's own tint. `none` stays literal.
 * A fixed colour is refused: see the header.
 */
function paint(value: string | undefined, entry: IconEntry, slot: string): string {
  if (value === undefined || value === 'currentColor') return '{tint}';
  if (value === 'none') return '"none"';
  throw new Error(`${entry.id}: ${slot}="${value}" is a fixed colour; re-draw it against a token`);
}

function jsxFor(leaf: Element, entry: IconEntry): string {
  const props: string[] = [];

  if (leaf.tag === 'path') {
    const d = leaf.attrs.d;
    if (d === undefined) throw new Error(`${entry.id}: a <path> with no d`);
    if (d.includes('"')) throw new Error(`${entry.id}: path data contains a quote`);
    props.push(`d="${d}"`);
  } else {
    for (const key of ['cx', 'cy', 'r'] as const) {
      const value = leaf.attrs[key];
      if (value === undefined) throw new Error(`${entry.id}: a <circle> with no ${key}`);
      props.push(`${key}={${value}}`);
    }
  }

  props.push(`fill=${paint(leaf.attrs.fill, entry, 'fill')}`);
  if (leaf.attrs.stroke !== undefined) props.push(`stroke=${paint(leaf.attrs.stroke, entry, 'stroke')}`);
  if (leaf.attrs['stroke-width'] !== undefined) props.push(`strokeWidth={${leaf.attrs['stroke-width']}}`);
  for (const [svg, rn] of STRING_PROPS) {
    if (leaf.attrs[svg] !== undefined) props.push(`${rn}="${leaf.attrs[svg]}"`);
  }

  const tag = leaf.tag === 'path' ? 'Path' : 'Circle';
  return `      <${tag}\n${props.map((prop) => `        ${prop}`).join('\n')}\n      />`;
}

function render(entry: IconEntry, symbol: Element): string {
  const leaves = flatten(symbol, {});
  if (leaves.length === 0) throw new Error(`${entry.id}: the symbol draws nothing`);

  // Only the stroke-drawn symbols declare it, and only they need it; every leaf
  // states its own fill, so carrying `fill="none"` onto a filled glyph's root
  // would just read as a contradiction.
  const rootFill = symbol.attrs.fill === 'none' ? ' fill="none"' : '';

  const imports = [...new Set(leaves.map((leaf) => (leaf.tag === 'path' ? 'Path' : 'Circle')))].sort();
  const component = `${entry.name}Icon`;

  return `import Svg, { ${imports.join(', ')} } from "react-native-svg";
import { useColorScheme } from "@/lib/useColorScheme";

export interface ${component}Props {
  size?: number;
  /** Icon color. Defaults to the theme muted foreground, as the sibling glyph components do. */
  color?: string;
}

/**
 * \`${entry.id}\` — ${entry.purpose}.
 *
 * Generated from \`scripts/icons/shell-sprites.svg\`. Change \`scripts/icons/manifest.ts\`
 * and re-run \`bun run generate:icons\`; editing this file is reverted by the next run
 * and caught by \`components/__tests__/generated-icons.test.ts\`.
 */
export function ${component}({ size = 18, color }: ${component}Props) {
  const { colors } = useColorScheme();
  const tint = color ?? colors.mutedForeground;
  return (
    <Svg width={size} height={size} viewBox="${symbol.attrs.viewBox}"${rootFill}>
${leaves.map((leaf) => jsxFor(leaf, entry)).join('\n')}
    </Svg>
  );
}
`;
}

/**
 * The components this manifest produces, keyed by filename.
 *
 * Pure: the write side is `write.ts`, so the test can ask what SHOULD be on
 * disk without putting it there — a generator that writes before it compares
 * can only ever agree with itself.
 */
export function generate(): Map<string, string> {
  const sheet = parse(readFileSync(SHEET, 'utf8'));
  const svg = sheet.children.find((child) => child.tag === 'svg');
  if (svg === undefined) throw new Error('the sheet has no <svg> root');

  const symbols = new Map<string, Element>();
  for (const child of svg.children) {
    if (child.tag !== 'symbol') throw new Error(`<${child.tag}> at the sheet's top level`);
    if (symbols.has(child.attrs.id)) throw new Error(`the sheet declares "${child.attrs.id}" twice`);
    symbols.set(child.attrs.id, child);
  }

  const files = new Map<string, string>();
  for (const entry of ICONS) {
    const symbol = symbols.get(entry.id);
    if (symbol === undefined) throw new Error(`the sheet has no "${entry.id}"`);
    if (symbol.attrs.viewBox === undefined) throw new Error(`"${entry.id}" has no viewBox`);
    const file = `${kebab(entry.name)}-icon.tsx`;
    if (files.has(file)) throw new Error(`two manifest entries both want ${file}`);
    files.set(file, render(entry, symbol));
  }
  return files;
}
