import { tool } from 'ai';
import { z } from 'zod';

/**
 * `generateFile`: a document the person can download, from content the model
 * already wrote.
 *
 * ## What the model sends
 *
 * The schema used to make `format` a required four-value enum (`csv`, `json`,
 * `markdown`, `text`). A model asked for a web page sends `format: "html"` —
 * and for an SVG, a script or a config file, whatever name the language has —
 * and the whole call was refused as "Invalid tool call: Type validation
 * failed" (production), although the filename (`index.html`) already said
 * everything there was to say. A model that gets that refusal usually retries
 * with `text`, which labels the file wrongly.
 *
 * So the filename is the source of truth and `format` is an optional label:
 * any string is accepted, spelled as the model likes (`md`, `HTML`,
 * `text/html`), and normalised to the canonical name here. Nothing about a
 * file's kind can make the call invalid; only a missing name or content can.
 */

/** Canonical format of a file extension. */
const FORMAT_BY_EXTENSION: ReadonlyMap<string, string> = new Map(
  Object.entries({
    csv: 'csv',
    tsv: 'tsv',
    json: 'json',
    jsonl: 'json',
    md: 'markdown',
    markdown: 'markdown',
    txt: 'text',
    text: 'text',
    log: 'text',
    html: 'html',
    htm: 'html',
    xml: 'xml',
    svg: 'svg',
    css: 'css',
    js: 'javascript',
    mjs: 'javascript',
    ts: 'typescript',
    tsx: 'typescript',
    jsx: 'javascript',
    py: 'python',
    sql: 'sql',
    sh: 'shell',
    yml: 'yaml',
    yaml: 'yaml',
    toml: 'toml',
    ini: 'ini',
    ics: 'icalendar',
    vcf: 'vcard',
  }),
);

/** Other spellings of a format a model may use, mapped to the canonical name. */
const FORMAT_ALIASES: ReadonlyMap<string, string> = new Map(
  Object.entries({
    md: 'markdown',
    txt: 'text',
    plain: 'text',
    'plain text': 'text',
    plaintext: 'text',
    htm: 'html',
    js: 'javascript',
    ts: 'typescript',
    py: 'python',
    yml: 'yaml',
    sh: 'shell',
    bash: 'shell',
  }),
);

function extensionOf(filename: string): string | null {
  const dot = filename.lastIndexOf('.');
  return dot > 0 && dot < filename.length - 1 ? filename.slice(dot + 1).toLowerCase() : null;
}

/**
 * The canonical format of a file: the one the model named when it named one,
 * otherwise the one its extension implies, otherwise `text`.
 */
export function resolveFileFormat(filename: string, format: string | undefined): string {
  const named = format
    ?.trim()
    .toLowerCase()
    // `text/html` and `application/json` name the format after the slash.
    .replace(/^[a-z]+\//, '')
    .replace(/^\./, '');
  if (named) {
    return FORMAT_ALIASES.get(named) ?? FORMAT_BY_EXTENSION.get(named) ?? named;
  }
  const extension = extensionOf(filename);
  return (extension && FORMAT_BY_EXTENSION.get(extension)) ?? extension ?? 'text';
}

/** Formats shown as prose; every other format is shown as code in its language. */
const PROSE_FORMATS = new Set(['markdown', 'text']);

export const generateFileTool = tool({
  description:
    'Generate a file (CSV, JSON, Markdown, HTML, text, code…) with the given content, as a download.',
  inputSchema: z.object({
    filename: z.string().min(1).describe('Name with extension, e.g. "report.csv", "page.html"'),
    content: z.string().describe('The content of the file'),
    format: z
      .string()
      .optional()
      .describe('Optional; taken from the filename extension when left out'),
  }),
  execute: async ({ filename, content, format }) => {
    const resolved = resolveFileFormat(filename, format);
    return {
      filename,
      format: resolved,
      // The client renders a result with a `language` as code, anything else as
      // Markdown — which would turn an HTML file into a rendered page.
      ...(PROSE_FORMATS.has(resolved) ? {} : { language: resolved }),
      content,
      message: `Generated ${filename} (${resolved} format, ${content.length} characters)`,
    };
  },
});
