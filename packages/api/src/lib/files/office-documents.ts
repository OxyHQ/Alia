/**
 * The text of a Word, PowerPoint or Excel file (Office Open XML), for a model
 * that reads text (`person-files.ts`).
 *
 * - Word: the body's paragraphs and tables, in document order. A table is one
 *   line per row, its cells separated by ` | `.
 * - PowerPoint: `Slide N` and that slide's text, in the presentation's order,
 *   then its speaker notes under `Notes:`.
 * - Excel: `Sheet: <name>` and that sheet's rows as CSV, with the values the
 *   file stores (shared and inline strings, numbers, booleans, a formula's
 *   cached result). Empty trailing cells are dropped and so are empty rows.
 *
 * ## The archive is untrusted
 *
 * An Office file is a zip the person uploaded. Only the few XML parts a reader
 * names are inflated, and only while their DECLARED sizes add up to less than
 * {@link MAX_OFFICE_XML_BYTES}: `adm-zip` caps each inflation at the size its
 * header declares, so a part that lies about its size cannot expand past it.
 * The sum of the declarations is therefore a real bound on memory, checked
 * before anything is inflated.
 *
 * ## The XML is untrusted
 *
 * It is read by {@link scanXml}, a tokenizer that knows no DTD: a document type
 * declaration is refused outright and only the five predefined entities and
 * character references are decoded, so there is no entity to expand. Elements
 * are matched by their local name, because a prefix is only a convention.
 *
 * Every reader stops collecting once it has more than `maxChars`; the caller
 * clips to its own bound and says the document continues.
 */
import AdmZip from 'adm-zip';

/** The most XML one document may inflate, summed over the parts read, in bytes. */
export const MAX_OFFICE_XML_BYTES = 64 * 1024 * 1024;
/** An archive listing more entries than this is not an Office document anyone wrote. */
const MAX_OFFICE_ENTRIES = 20_000;

export type OfficeKind = 'word' | 'powerpoint' | 'excel';

const OFFICE_MIME: ReadonlyMap<string, OfficeKind> = new Map([
  ['application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'word'],
  ['application/vnd.openxmlformats-officedocument.wordprocessingml.template', 'word'],
  ['application/vnd.ms-word.document.macroenabled.12', 'word'],
  ['application/vnd.ms-word.template.macroenabled.12', 'word'],
  ['application/vnd.openxmlformats-officedocument.presentationml.presentation', 'powerpoint'],
  ['application/vnd.openxmlformats-officedocument.presentationml.slideshow', 'powerpoint'],
  ['application/vnd.openxmlformats-officedocument.presentationml.template', 'powerpoint'],
  ['application/vnd.ms-powerpoint.presentation.macroenabled.12', 'powerpoint'],
  ['application/vnd.ms-powerpoint.slideshow.macroenabled.12', 'powerpoint'],
  ['application/vnd.ms-powerpoint.template.macroenabled.12', 'powerpoint'],
  ['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'excel'],
  ['application/vnd.openxmlformats-officedocument.spreadsheetml.template', 'excel'],
  ['application/vnd.ms-excel.sheet.macroenabled.12', 'excel'],
  ['application/vnd.ms-excel.template.macroenabled.12', 'excel'],
]);

/** Which Office reader a (lower-case) mime type takes, if any. */
export function officeKindOf(mime: string): OfficeKind | undefined {
  return OFFICE_MIME.get(mime);
}

/** Why an Office file could not be read: not a zip, a part missing, or too large. */
export class OfficeDocumentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OfficeDocumentError';
  }
}

/* -------------------------------------------------------------------------- */
/*  XML                                                                       */
/* -------------------------------------------------------------------------- */

export interface XmlHandler {
  open?(name: string, attributes: Readonly<Record<string, string>>, selfClosing: boolean): void;
  close?(name: string): void;
  text?(text: string): void;
}

const PREDEFINED_ENTITIES: ReadonlyMap<string, string> = new Map([
  ['lt', '<'],
  ['gt', '>'],
  ['amp', '&'],
  ['quot', '"'],
  ['apos', "'"],
]);

/** Character references and the five predefined entities; anything else stays as written. */
export function decodeXmlText(raw: string): string {
  if (!raw.includes('&')) return raw;
  return raw.replace(/&(#x[0-9a-f]+|#[0-9]+|[a-z]+);/gi, (whole, body: string) => {
    if (body[0] !== '#') return PREDEFINED_ENTITIES.get(body) ?? whole;
    const code =
      body[1] === 'x' || body[1] === 'X'
        ? Number.parseInt(body.slice(2), 16)
        : Number.parseInt(body.slice(1), 10);
    return Number.isInteger(code) && code >= 0 && code <= 0x10ffff
      ? String.fromCodePoint(code)
      : whole;
  });
}

function localName(qualified: string): string {
  const colon = qualified.indexOf(':');
  return colon === -1 ? qualified : qualified.slice(colon + 1);
}

const ATTRIBUTE = /([^\s=/]+)\s*=\s*("([^"]*)"|'([^']*)')/g;

function attributesOf(source: string): Record<string, string> {
  const attributes: Record<string, string> = Object.create(null);
  for (const match of source.matchAll(ATTRIBUTE)) {
    attributes[match[1]] = decodeXmlText(match[3] ?? match[4] ?? '');
  }
  return attributes;
}

/**
 * The `r:id` of an element that points at another part. Attributes keep their
 * prefix because the names collide: a slide's `<p:sldId id="256" r:id="rId2">`
 * has both, and only the prefixed one is the relationship.
 */
function relationshipId(attributes: Readonly<Record<string, string>>): string | undefined {
  for (const [name, value] of Object.entries(attributes)) {
    if (name.endsWith(':id')) return value;
  }
  return undefined;
}

/** Where the tag opened at `from` ends: its `>`, outside any quoted attribute value. */
function tagEnd(xml: string, from: number): number {
  let quote = '';
  for (let index = from; index < xml.length; index++) {
    const char = xml[index];
    if (quote !== '') {
      if (char === quote) quote = '';
    } else if (char === '"' || char === "'") {
      quote = char;
    } else if (char === '>') {
      return index;
    }
  }
  return -1;
}

/**
 * Walk an XML document, calling `handler` for each element and run of text.
 * Element names reach the handler as local names (`w:t` is `t`); attribute
 * names as written (`r:id`).
 */
export function scanXml(xml: string, handler: XmlHandler): void {
  let index = 0;
  while (index < xml.length) {
    const lt = xml.indexOf('<', index);
    if (lt === -1) {
      handler.text?.(decodeXmlText(xml.slice(index)));
      return;
    }
    if (lt > index) handler.text?.(decodeXmlText(xml.slice(index, lt)));
    if (xml.startsWith('<!--', lt)) {
      const end = xml.indexOf('-->', lt + 4);
      if (end === -1) return;
      index = end + 3;
      continue;
    }
    if (xml.startsWith('<![CDATA[', lt)) {
      const end = xml.indexOf(']]>', lt + 9);
      if (end === -1) throw new OfficeDocumentError('unterminated CDATA section');
      handler.text?.(xml.slice(lt + 9, end));
      index = end + 3;
      continue;
    }
    if (xml.startsWith('<!', lt)) {
      throw new OfficeDocumentError('a document type declaration is not accepted');
    }
    const gt = tagEnd(xml, lt + 1);
    if (gt === -1) throw new OfficeDocumentError('unterminated tag');
    index = gt + 1;
    if (xml[lt + 1] === '?') continue;
    if (xml[lt + 1] === '/') {
      handler.close?.(localName(xml.slice(lt + 2, gt).trim()));
      continue;
    }
    const selfClosing = xml[gt - 1] === '/';
    const body = xml.slice(lt + 1, selfClosing ? gt - 1 : gt);
    const nameEnd = body.search(/[\s/]/);
    const name = localName(nameEnd === -1 ? body : body.slice(0, nameEnd));
    handler.open?.(
      name,
      nameEnd === -1 || handler.open === undefined ? {} : attributesOf(body.slice(nameEnd)),
      selfClosing,
    );
    if (selfClosing) handler.close?.(name);
  }
}

/* -------------------------------------------------------------------------- */
/*  The archive                                                               */
/* -------------------------------------------------------------------------- */

class OfficeArchive {
  private readonly zip: AdmZip;
  private readonly byLowerName = new Map<string, AdmZip.IZipEntry>();
  private inflated = 0;

  constructor(bytes: Uint8Array) {
    try {
      this.zip = new AdmZip(Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength));
    } catch {
      throw new OfficeDocumentError('not a readable Office document');
    }
    const entries = this.zip.getEntries();
    if (entries.length > MAX_OFFICE_ENTRIES) {
      throw new OfficeDocumentError('the archive lists too many entries');
    }
    for (const entry of entries) this.byLowerName.set(entry.entryName.toLowerCase(), entry);
  }

  /** A part's XML, or `undefined` when the archive has no such part. */
  read(path: string): string | undefined {
    const entry = this.byLowerName.get(path.replace(/^\/+/, '').toLowerCase());
    if (entry === undefined || entry.isDirectory) return undefined;
    this.inflated += entry.header.size;
    if (this.inflated > MAX_OFFICE_XML_BYTES) {
      throw new OfficeDocumentError(`the document expands past ${MAX_OFFICE_XML_BYTES} bytes`);
    }
    let data: Buffer;
    try {
      data = entry.getData();
    } catch {
      throw new OfficeDocumentError(`the part ${path} is damaged`);
    }
    return new TextDecoder().decode(data);
  }

  /** Every part whose path matches. */
  paths(pattern: RegExp): string[] {
    return [...this.byLowerName.values()]
      .map((entry) => entry.entryName)
      .filter((name) => pattern.test(name));
  }
}

/** The targets of a part's relationships, by id, as paths from the archive root. */
function relationships(
  archive: OfficeArchive,
  partPath: string,
): Map<string, { target: string; type: string }> {
  const slash = partPath.lastIndexOf('/');
  const directory = slash === -1 ? '' : partPath.slice(0, slash);
  const name = partPath.slice(slash + 1);
  const xml = archive.read(`${directory ? `${directory}/` : ''}_rels/${name}.rels`);
  const found = new Map<string, { target: string; type: string }>();
  if (xml === undefined) return found;
  scanXml(xml, {
    open(element, attributes) {
      if (element !== 'Relationship' || attributes.TargetMode === 'External') return;
      const { Id: id, Target: target, Type: type = '' } = attributes;
      if (id === undefined || target === undefined) return;
      found.set(id, { target: resolvePartPath(directory, target), type });
    },
  });
  return found;
}

function resolvePartPath(directory: string, target: string): string {
  const segments = target.startsWith('/') ? [] : directory.split('/').filter(Boolean);
  for (const segment of target.split('/')) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') segments.pop();
    else segments.push(segment);
  }
  return segments.join('/');
}

/** Collects lines until it holds more than `maxChars`, then reports itself full. */
class Lines {
  private readonly lines: string[] = [];
  private chars = 0;

  constructor(private readonly maxChars: number) {}

  get full(): boolean {
    return this.chars > this.maxChars;
  }

  push(line: string): void {
    if (this.full) return;
    this.lines.push(line);
    this.chars += line.length + 1;
  }

  toString(): string {
    return this.lines.join('\n');
  }
}

/* -------------------------------------------------------------------------- */
/*  Word and DrawingML text                                                   */
/* -------------------------------------------------------------------------- */

interface TableState {
  rows: string[];
  row: string[] | null;
  cell: string[] | null;
}

/** Elements whose content is never text: properties, tab stops, and `mc:Fallback`, which repeats its `mc:Choice`. */
const NOT_TEXT = new Set(['Fallback', 'pPr', 'rPr', 'tabs', 'sectPr']);

/**
 * Paragraphs and tables, as Word and DrawingML (slides) both write them: `p`
 * holds runs whose `t` is text, `tbl`/`tr`/`tc` a table. A paragraph inside a
 * paragraph (a text box) is folded into the one that holds it; a table inside a
 * table cell becomes that cell's text.
 */
function textBlockHandler(emit: (block: string) => void, isFull: () => boolean): XmlHandler {
  const paragraphs: string[][] = [];
  const tables: TableState[] = [];
  let inText = 0;
  let skipped = 0;

  const place = (text: string): void => {
    const table = tables.at(-1);
    if (table?.cell) table.cell.push(text);
    else if (paragraphs.length > 0) paragraphs[paragraphs.length - 1].push(text);
    else emit(text);
  };

  return {
    open(name) {
      if (skipped > 0 || NOT_TEXT.has(name)) {
        skipped++;
        return;
      }
      if (isFull()) return;
      switch (name) {
        case 'p':
          paragraphs.push([]);
          break;
        case 't':
          inText++;
          break;
        case 'tab':
          if (inText === 0) paragraphs.at(-1)?.push('\t');
          break;
        case 'br':
        case 'cr':
          paragraphs.at(-1)?.push('\n');
          break;
        case 'noBreakHyphen':
          paragraphs.at(-1)?.push('-');
          break;
        case 'tbl':
          tables.push({ rows: [], row: null, cell: null });
          break;
        case 'tr':
          if (tables.length > 0) tables[tables.length - 1].row = [];
          break;
        case 'tc':
          if (tables.length > 0) tables[tables.length - 1].cell = [];
          break;
      }
    },
    close(name) {
      if (skipped > 0) {
        skipped--;
        return;
      }
      switch (name) {
        case 'p': {
          const text = paragraphs.pop()?.join('') ?? '';
          if (paragraphs.length > 0 && !tables.at(-1)?.cell) {
            if (text.trim() !== '') paragraphs[paragraphs.length - 1].push(` ${text} `);
          } else if (text.trim() !== '' || paragraphs.length === 0) {
            place(text.replace(/ {2,}/g, ' ').trim());
          }
          break;
        }
        case 't':
          inText = Math.max(0, inText - 1);
          break;
        case 'tc': {
          const table = tables.at(-1);
          if (table?.cell && table.row) {
            table.row.push(table.cell.join(' ').replace(/\s+/g, ' ').trim());
          }
          if (table) table.cell = null;
          break;
        }
        case 'tr': {
          const table = tables.at(-1);
          if (table?.row) {
            while (table.row.length > 0 && table.row[table.row.length - 1] === '') table.row.pop();
            if (table.row.length > 0) table.rows.push(table.row.join(' | '));
          }
          if (table) table.row = null;
          break;
        }
        case 'tbl': {
          const table = tables.pop();
          if (table && table.rows.length > 0) place(table.rows.join('\n'));
          break;
        }
      }
    },
    text(text) {
      if (skipped === 0 && inText > 0) paragraphs.at(-1)?.push(text);
    },
  };
}

function wordText(archive: OfficeArchive, maxChars: number): string {
  const xml = archive.read('word/document.xml');
  if (xml === undefined) throw new OfficeDocumentError('the document has no body');
  const lines = new Lines(maxChars);
  let blank = false;
  scanXml(
    xml,
    textBlockHandler(
      (block) => {
        const isBlank = block.trim() === '';
        if (isBlank && blank) return;
        blank = isBlank;
        lines.push(isBlank ? '' : block);
      },
      () => lines.full,
    ),
  );
  return lines.toString();
}

/* -------------------------------------------------------------------------- */
/*  PowerPoint                                                                */
/* -------------------------------------------------------------------------- */

/** The slide parts in presentation order; the numbered parts if the order cannot be read. */
function slidePaths(archive: OfficeArchive): string[] {
  const presentation = archive.read('ppt/presentation.xml');
  if (presentation !== undefined) {
    const targets = relationships(archive, 'ppt/presentation.xml');
    const ordered: string[] = [];
    scanXml(presentation, {
      open(name, attributes) {
        const id = name === 'sldId' ? relationshipId(attributes) : undefined;
        const relationship = id === undefined ? undefined : targets.get(id);
        if (relationship) ordered.push(relationship.target);
      },
    });
    if (ordered.length > 0) return ordered;
  }
  return archive
    .paths(/^ppt\/slides\/slide\d+\.xml$/i)
    .sort(
      (a, b) => Number(/(\d+)\.xml$/i.exec(a)?.[1] ?? 0) - Number(/(\d+)\.xml$/i.exec(b)?.[1] ?? 0),
    );
}

function powerpointText(archive: OfficeArchive, maxChars: number): string {
  const lines = new Lines(maxChars);
  const paths = slidePaths(archive);
  for (const [index, path] of paths.entries()) {
    if (lines.full) break;
    const xml = archive.read(path);
    if (xml === undefined) continue;
    lines.push(`${index === 0 ? '' : '\n'}Slide ${index + 1}`);
    for (const block of shapeTexts(xml)) lines.push(block);
    const notes = [...relationships(archive, path).values()].find((relationship) =>
      relationship.type.endsWith('/notesSlide'),
    );
    const notesXml = notes ? archive.read(notes.target) : undefined;
    if (notesXml === undefined) continue;
    const spoken = shapeTexts(notesXml, 'body');
    if (spoken.length > 0) {
      lines.push('Notes:');
      for (const block of spoken) lines.push(block);
    }
  }
  return lines.toString();
}

/**
 * The text of each shape of a slide or notes page, in the order the shapes
 * are drawn. With `placeholder`, only the shapes that are that kind of
 * placeholder: a notes page also holds the slide's thumbnail, its number and
 * its header, and only its `body` is the speaker's notes.
 */
function shapeTexts(xml: string, placeholder?: string): string[] {
  const shapes: { type?: string; blocks: string[] }[] = [];
  let current: { type?: string; blocks: string[] } | null = null;
  let depth = 0;
  const blocks = textBlockHandler(
    (block) => {
      if (current && block.trim() !== '') current.blocks.push(block);
    },
    () => false,
  );
  scanXml(xml, {
    open(name, attributes, selfClosing) {
      if (name === 'sp' || name === 'graphicFrame') {
        depth++;
        if (depth === 1) current = { blocks: [] };
      } else if (name === 'ph' && current && depth === 1) {
        current.type = attributes.type ?? 'body';
      }
      blocks.open?.(name, attributes, selfClosing);
    },
    close(name) {
      blocks.close?.(name);
      if (name !== 'sp' && name !== 'graphicFrame') return;
      depth--;
      if (depth === 0 && current) {
        shapes.push(current);
        current = null;
      }
    },
    text: blocks.text,
  });
  return shapes
    .filter((shape) => placeholder === undefined || shape.type === placeholder)
    .flatMap((shape) => shape.blocks);
}

/* -------------------------------------------------------------------------- */
/*  Excel                                                                     */
/* -------------------------------------------------------------------------- */

function sharedStrings(archive: OfficeArchive): string[] {
  const xml = archive.read('xl/sharedStrings.xml');
  if (xml === undefined) return [];
  const strings: string[] = [];
  let current: string[] | null = null;
  let inText = 0;
  let phonetic = 0;
  scanXml(xml, {
    open(name) {
      if (name === 'si') current = [];
      else if (name === 'rPh') phonetic++;
      else if (name === 't' && phonetic === 0) inText++;
    },
    close(name) {
      if (name === 'si') {
        strings.push(current?.join('') ?? '');
        current = null;
      } else if (name === 'rPh') phonetic = Math.max(0, phonetic - 1);
      else if (name === 't' && phonetic === 0) inText = Math.max(0, inText - 1);
    },
    text(text) {
      if (inText > 0 && current) current.push(text);
    },
  });
  return strings;
}

function sheetPaths(archive: OfficeArchive): { name: string; path: string }[] {
  const workbook = archive.read('xl/workbook.xml');
  if (workbook === undefined) throw new OfficeDocumentError('the workbook has no sheet list');
  const targets = relationships(archive, 'xl/workbook.xml');
  const sheets: { name: string; path: string }[] = [];
  scanXml(workbook, {
    open(name, attributes) {
      const id = name === 'sheet' ? relationshipId(attributes) : undefined;
      const relationship = id === undefined ? undefined : targets.get(id);
      if (relationship && /\/worksheet$/.test(relationship.type)) {
        sheets.push({
          name: attributes.name ?? `Sheet ${sheets.length + 1}`,
          path: relationship.target,
        });
      }
    },
  });
  return sheets;
}

/** The zero-based column of a cell reference (`C7` is 2), or `undefined`. */
function columnOf(reference: string | undefined): number | undefined {
  const letters = reference === undefined ? undefined : /^([A-Z]{1,3})\d*$/i.exec(reference)?.[1];
  if (letters === undefined) return undefined;
  let column = 0;
  for (const letter of letters.toUpperCase()) column = column * 26 + (letter.charCodeAt(0) - 64);
  return column - 1;
}

const MAX_SHEET_COLUMNS = 16_384;

function csvField(value: string): string {
  return /[",\n\r]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

function sheetRows(xml: string, strings: readonly string[], lines: Lines): void {
  let row: string[] | null = null;
  let cell: { column: number; type: string; value: string[]; inline: string[] } | null = null;
  let reading: 'value' | 'inline' | null = null;
  let phonetic = 0;
  scanXml(xml, {
    open(name, attributes) {
      if (lines.full) return;
      if (name === 'row') {
        row = [];
      } else if (name === 'c' && row) {
        const column = columnOf(attributes.r) ?? row.length;
        cell = {
          column: Math.min(column, MAX_SHEET_COLUMNS),
          type: attributes.t ?? 'n',
          value: [],
          inline: [],
        };
      } else if (name === 'v' && cell) {
        reading = 'value';
      } else if (name === 'rPh') {
        phonetic++;
      } else if (name === 't' && cell && phonetic === 0) {
        reading = 'inline';
      }
    },
    close(name) {
      if (name === 'v' || name === 't') {
        reading = null;
      } else if (name === 'rPh') {
        phonetic = Math.max(0, phonetic - 1);
      } else if (name === 'c' && cell && row) {
        const raw = cell.value.join('');
        let value: string;
        switch (cell.type) {
          case 's':
            value = strings[Number(raw)] ?? '';
            break;
          case 'inlineStr':
            value = cell.inline.join('');
            break;
          case 'b':
            value = raw === '1' ? 'TRUE' : raw === '0' ? 'FALSE' : raw;
            break;
          default:
            value = raw;
        }
        if (value !== '') {
          while (row.length < cell.column) row.push('');
          row[cell.column] = value;
        }
        cell = null;
      } else if (name === 'row' && row) {
        while (row.length > 0 && (row[row.length - 1] ?? '') === '') row.pop();
        if (row.length > 0) lines.push(Array.from(row, (value) => csvField(value ?? '')).join(','));
        row = null;
      }
    },
    text(text) {
      if (!cell || reading === null) return;
      if (reading === 'value') cell.value.push(text);
      else cell.inline.push(text);
    },
  });
}

function excelText(archive: OfficeArchive, maxChars: number): string {
  const strings = sharedStrings(archive);
  const lines = new Lines(maxChars);
  for (const [index, sheet] of sheetPaths(archive).entries()) {
    if (lines.full) break;
    const xml = archive.read(sheet.path);
    if (xml === undefined) continue;
    lines.push(`${index === 0 ? '' : '\n'}Sheet: ${sheet.name}`);
    sheetRows(xml, strings, lines);
  }
  return lines.toString();
}

/* -------------------------------------------------------------------------- */

/**
 * The text of an Office document, or an {@link OfficeDocumentError}. At most a
 * little more than `maxChars` is collected; the caller clips.
 */
export function officeText(kind: OfficeKind, bytes: Uint8Array, maxChars: number): string {
  const archive = new OfficeArchive(bytes);
  switch (kind) {
    case 'word':
      return wordText(archive, maxChars);
    case 'powerpoint':
      return powerpointText(archive, maxChars);
    case 'excel':
      return excelText(archive, maxChars);
  }
}
