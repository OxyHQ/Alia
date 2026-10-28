/**
 * Word, PowerPoint and Excel files become the text a model reads: in the
 * order a person reads them, without the XML's repetitions, and never at the
 * cost of inflating whatever an uploaded archive claims to hold.
 */
import { describe, expect, it } from 'vitest';
import {
  decodeXmlText,
  MAX_OFFICE_XML_BYTES,
  OfficeDocumentError,
  officeKindOf,
  officeText,
  scanXml,
} from '../office-documents.js';
import { docx, pptx, xlsx, zip } from './document-fixtures.js';

describe('officeKindOf', () => {
  it('knows the Office Open XML types and their macro-enabled and template siblings', () => {
    expect(
      officeKindOf('application/vnd.openxmlformats-officedocument.wordprocessingml.document'),
    ).toBe('word');
    expect(officeKindOf('application/vnd.ms-word.document.macroenabled.12')).toBe('word');
    expect(
      officeKindOf('application/vnd.openxmlformats-officedocument.presentationml.slideshow'),
    ).toBe('powerpoint');
    expect(officeKindOf('application/vnd.ms-excel.sheet.macroenabled.12')).toBe('excel');
    expect(officeKindOf('application/vnd.ms-excel')).toBeUndefined();
    expect(officeKindOf('application/msword')).toBeUndefined();
    expect(officeKindOf('constructor')).toBeUndefined();
  });
});

describe('Word', () => {
  it('reads paragraphs and tables in order, once each, without deleted text or tab stops', () => {
    expect(officeText('word', docx(), 10_000)).toBe(
      [
        'Lease & terms',
        'Rent:\t900 EUR',
        '',
        'Month | Paid',
        'January | yes in cash',
        'Signed by Ana Done.',
      ].join('\n'),
    );
  });

  it('refuses a file with no document body', () => {
    expect(() => officeText('word', zip({ 'word/other.xml': '<x/>' }), 100)).toThrow(
      OfficeDocumentError,
    );
  });
});

describe('PowerPoint', () => {
  it('reads each slide in presentation order, with its tables and speaker notes only', () => {
    expect(officeText('powerpoint', pptx(), 10_000)).toBe(
      [
        'Slide 1',
        'Quarterly results',
        'Revenue grew',
        'Costs fell',
        'Q1 | 12%',
        'Notes:',
        'Mention the hiring freeze',
        '',
        'Slide 2',
        'Thank you',
      ].join('\n'),
    );
  });
});

describe('Excel', () => {
  it('reads each sheet as CSV rows of the stored values', () => {
    expect(officeText('excel', xlsx(), 10_000)).toBe(
      [
        'Sheet: Rent',
        'Tenant,"Amount ""EUR"""',
        '"Ana, Pérez",900.5,TRUE',
        'Total,,900.5',
        '',
        'Sheet: Notes',
        ',Paid on time',
      ].join('\n'),
    );
  });

  it('stops collecting once it holds more than it was asked for', () => {
    const rows = Array.from(
      { length: 5_000 },
      (_, index) =>
        `<row r="${index + 1}"><c r="A${index + 1}" t="inlineStr"><is><t>row ${index + 1} of many</t></is></c></row>`,
    ).join('');
    const text = officeText('excel', xlsx(rows), 1_000);
    expect(text.length).toBeGreaterThan(1_000);
    expect(text.length).toBeLessThan(1_200);
    expect(text).not.toContain('Sheet: Notes');
  });
});

describe('the archive and its XML are untrusted', () => {
  it('refuses bytes that are not a zip', () => {
    expect(() => officeText('word', new TextEncoder().encode('not a zip'), 100)).toThrow(
      OfficeDocumentError,
    );
  });

  it('refuses a document that expands past the bound, before inflating it', () => {
    const huge = `<w:document><w:body><w:p><w:r><w:t>${' '.repeat(MAX_OFFICE_XML_BYTES)}</w:t></w:r></w:p></w:body></w:document>`;
    const bytes = zip({ 'word/document.xml': huge });
    expect(bytes.length).toBeLessThan(MAX_OFFICE_XML_BYTES / 100);
    expect(() => officeText('word', bytes, 100)).toThrow(/expands past/);
  });

  it('refuses a document type declaration and expands no entity', () => {
    const billion = `<?xml version="1.0"?><!DOCTYPE lolz [<!ENTITY lol "lol"><!ENTITY lol2 "&lol;&lol;">]><w:document><w:body><w:p><w:r><w:t>&lol2;</w:t></w:r></w:p></w:body></w:document>`;
    expect(() => officeText('word', zip({ 'word/document.xml': billion }), 100)).toThrow(
      /document type declaration/,
    );
    expect(decodeXmlText('&lol2; &amp; &#65;&#x42; &bogus; &constructor;')).toBe(
      '&lol2; & AB &bogus; &constructor;',
    );
  });

  it('reads a `>` inside an attribute value as part of the value', () => {
    const seen: string[] = [];
    scanXml('<a title="1 > 0"><b/>text</a>', {
      open: (name, attributes) => seen.push(`${name}:${attributes.title ?? ''}`),
      text: (text) => seen.push(text),
    });
    expect(seen).toEqual(['a:1 > 0', 'b:', 'text']);
  });
});
