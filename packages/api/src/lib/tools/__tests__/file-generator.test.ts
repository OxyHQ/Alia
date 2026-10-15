/**
 * `generateFile` accepts what a model really sends.
 *
 * Production: "Invalid tool call — Type validation failed" on `generateFile`
 * with HTML content. `format` was a required enum of `csv | json | markdown |
 * text`, so a page sent as `format: "html"` (or `md`, `text/html`, `HTML`) was
 * refused although `index.html` already said what it was.
 */
import { asSchema } from 'ai';
import { describe, expect, it } from 'vitest';

import { generateFileTool, resolveFileFormat } from '../file-generator.js';

const HTML = '<!doctype html><html><body><h1>Hola</h1><p>Informe "Q3" & más</p></body></html>';

async function validate(input: unknown) {
  const schema = asSchema(generateFileTool.inputSchema);
  return (await schema.validate?.(input)) ?? { success: true as const, value: input };
}

async function run(input: { filename: string; content: string; format?: string }) {
  return (await (
    generateFileTool as unknown as {
      execute: (args: typeof input, options: unknown) => Promise<Record<string, unknown>>;
    }
  ).execute(input, { toolCallId: 't', messages: [] })) as Record<string, unknown>;
}

describe('generateFile input', () => {
  it('accepts an HTML file with format html — the production call', async () => {
    const checked = await validate({ filename: 'informe.html', content: HTML, format: 'html' });
    expect(checked.success).toBe(true);
  });

  it('accepts any spelling of the format a model uses', async () => {
    for (const format of [
      'HTML',
      'text/html',
      '.html',
      'htm',
      'md',
      'Markdown',
      'xml',
      'svg',
      'yaml',
    ]) {
      expect(await validate({ filename: 'f', content: 'x', format })).toMatchObject({
        success: true,
      });
    }
  });

  it('does not need a format at all: the filename says it', async () => {
    expect(await validate({ filename: 'page.html', content: HTML })).toMatchObject({
      success: true,
    });
    const result = await run({ filename: 'page.html', content: HTML });
    expect(result).toMatchObject({ filename: 'page.html', format: 'html', content: HTML });
  });

  it('still refuses what is genuinely missing', async () => {
    expect(await validate({ content: 'x' })).toMatchObject({ success: false });
    expect(await validate({ filename: 'a.txt' })).toMatchObject({ success: false });
    expect(await validate({ filename: '', content: 'x' })).toMatchObject({ success: false });
  });

  it('shows the model a schema where format is optional', () => {
    const shown = asSchema(generateFileTool.inputSchema).jsonSchema as {
      required?: string[];
      properties: Record<string, { type?: string }>;
    };
    expect(shown.required).toEqual(['filename', 'content']);
    expect(shown.properties.format.type).toBe('string');
  });
});

describe('generateFile result', () => {
  it('normalises the format and keeps the content untouched', async () => {
    expect(await run({ filename: 'a.md', content: '# hi', format: 'md' })).toMatchObject({
      format: 'markdown',
      content: '# hi',
    });
    expect(
      await run({ filename: 'data', content: '{}', format: 'application/json' }),
    ).toMatchObject({ format: 'json' });
  });

  it('marks code-like formats with a language, so the client does not render a page as prose', async () => {
    expect(await run({ filename: 'p.html', content: HTML })).toMatchObject({ language: 'html' });
    expect(await run({ filename: 'a.csv', content: 'a,b' })).toMatchObject({ language: 'csv' });
    expect(await run({ filename: 'n.md', content: '# x' })).not.toHaveProperty('language');
    expect(await run({ filename: 'n.txt', content: 'x' })).not.toHaveProperty('language');
  });
});

describe('resolveFileFormat', () => {
  it('prefers the named format, then the extension, then text', () => {
    expect(resolveFileFormat('a.csv', 'json')).toBe('json');
    expect(resolveFileFormat('a.csv', undefined)).toBe('csv');
    expect(resolveFileFormat('a.csv', '  ')).toBe('csv');
    expect(resolveFileFormat('README', undefined)).toBe('text');
    expect(resolveFileFormat('x.weird', undefined)).toBe('weird');
    expect(resolveFileFormat('.gitignore', undefined)).toBe('text');
  });
});
