/**
 * Small Office and PDF files built in memory, so each test states the exact
 * XML or pixels it reads instead of pointing at a binary checked into the repo.
 */
import { deflateSync, inflateSync } from 'node:zlib';
import AdmZip from 'adm-zip';

const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';
const A = 'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"';
const P = 'xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"';
const R = 'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';
const REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';

export function zip(parts: Record<string, string>): Uint8Array<ArrayBuffer> {
  const archive = new AdmZip();
  for (const [path, content] of Object.entries(parts)) {
    archive.addFile(path, Buffer.from(content, 'utf8'));
  }
  return new Uint8Array(archive.toBuffer());
}

function relationshipsXml(
  relations: readonly { id: string; type: string; target: string }[],
): string {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${relations
    .map(
      (relation) =>
        `<Relationship Id="${relation.id}" Type="${REL}/${relation.type}" Target="${relation.target}"/>`,
    )
    .join('')}</Relationships>`;
}

const run = (text: string) =>
  `<w:r><w:rPr><w:b/></w:rPr><w:t xml:space="preserve">${text}</w:t></w:r>`;

/** A Word body: two paragraphs, a table, a text box written twice (Choice and Fallback), tracked changes. */
export function docx(body?: string): Uint8Array<ArrayBuffer> {
  const document =
    body ??
    `<w:p><w:pPr><w:tabs><w:tab w:val="left" w:pos="720"/></w:tabs></w:pPr>${run('Lease &amp; terms')}</w:p>
<w:p>${run('Rent:')}<w:r><w:tab/></w:r>${run('900 EUR')}<w:del><w:r><w:delText>1000 EUR</w:delText></w:r></w:del></w:p>
<w:p/>
<w:p/>
<w:tbl><w:tr><w:tc><w:p>${run('Month')}</w:p></w:tc><w:tc><w:p>${run('Paid')}</w:p></w:tc></w:tr>
<w:tr><w:tc><w:p>${run('January')}</w:p></w:tc><w:tc><w:p>${run('yes')}</w:p><w:p>${run('in cash')}</w:p></w:tc><w:tc><w:p/></w:tc></w:tr></w:tbl>
<w:p><w:r><mc:AlternateContent xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006"><mc:Choice Requires="wps"><w:drawing><w:txbxContent><w:p>${run('Signed by Ana')}</w:p></w:txbxContent></w:drawing></mc:Choice><mc:Fallback><w:pict><w:txbxContent><w:p>${run('Signed by Ana')}</w:p></w:txbxContent></w:pict></mc:Fallback></mc:AlternateContent></w:r>${run('Done.')}</w:p>`;
  return zip({
    '[Content_Types].xml': '<Types/>',
    'word/document.xml': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document ${W}><w:body>${document}<w:sectPr><w:pgSz w:w="12240"/></w:sectPr></w:body></w:document>`,
  });
}

function shape(text: string[], placeholder?: string): string {
  return `<p:sp><p:nvSpPr><p:cNvPr id="2" name="s"/><p:cNvSpPr/><p:nvPr>${
    placeholder === undefined ? '' : `<p:ph type="${placeholder}"/>`
  }</p:nvPr></p:nvSpPr><p:txBody><a:bodyPr/>${text
    .map((line) => `<a:p><a:r><a:rPr lang="en"/><a:t>${line}</a:t></a:r></a:p>`)
    .join('')}</p:txBody></p:sp>`;
}

function slide(shapes: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?><p:sld ${A} ${P} ${R}><p:cSld><p:spTree>${shapes}</p:spTree></p:cSld></p:sld>`;
}

/** Two slides stored in reverse order of presentation; the first has a table and speaker notes. */
export function pptx(): Uint8Array<ArrayBuffer> {
  const table = `<p:graphicFrame><a:graphic><a:graphicData><a:tbl><a:tr><a:tc><a:txBody><a:p><a:r><a:t>Q1</a:t></a:r></a:p></a:txBody></a:tc><a:tc><a:txBody><a:p><a:r><a:t>12%</a:t></a:r></a:p></a:txBody></a:tc></a:tr></a:tbl></a:graphicData></a:graphic></p:graphicFrame>`;
  return zip({
    'ppt/presentation.xml': `<p:presentation ${P} ${R}><p:sldIdLst><p:sldId r:id="rId3" id="256"/><p:sldId id="257" r:id="rId2"/></p:sldIdLst></p:presentation>`,
    'ppt/_rels/presentation.xml.rels': relationshipsXml([
      { id: 'rId2', type: 'slide', target: 'slides/slide1.xml' },
      { id: 'rId3', type: 'slide', target: 'slides/slide2.xml' },
    ]),
    'ppt/slides/slide2.xml': slide(
      shape(['Quarterly results'], 'title') + shape(['Revenue grew', 'Costs fell']) + table,
    ),
    'ppt/slides/_rels/slide2.xml.rels': relationshipsXml([
      { id: 'rId1', type: 'slideLayout', target: '../slideLayouts/slideLayout1.xml' },
      { id: 'rId2', type: 'notesSlide', target: '../notesSlides/notesSlide7.xml' },
    ]),
    'ppt/notesSlides/notesSlide7.xml': `<p:notes ${A} ${P}><p:cSld><p:spTree>${
      shape([], 'sldImg') + shape(['Mention the hiring freeze'], 'body') + shape(['1'], 'sldNum')
    }</p:spTree></p:cSld></p:notes>`,
    'ppt/slides/slide1.xml': slide(shape(['Thank you'], 'title')),
  });
}

/** Two sheets: shared, rich and inline strings, numbers, booleans, a formula, gaps and CSV quoting. */
export function xlsx(rows?: string): Uint8Array<ArrayBuffer> {
  const first =
    rows ??
    `<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c><c r="D1" s="3"/></row>
<row r="2"><c r="A2" t="inlineStr"><is><t>Ana, Pérez</t></is></c><c r="B2"><v>900.5</v></c><c r="C2" t="b"><v>1</v></c></row>
<row r="3"/>
<row r="4"><c r="A4" t="s"><v>2</v></c><c r="C4"><f>SUM(B2:B3)</f><v>900.5</v></c></row>`;
  return zip({
    'xl/workbook.xml': `<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" ${R}><sheets><sheet name="Rent" sheetId="1" r:id="rId1"/><sheet name="Notes" sheetId="2" r:id="rId2"/></sheets></workbook>`,
    'xl/_rels/workbook.xml.rels': relationshipsXml([
      { id: 'rId1', type: 'worksheet', target: 'worksheets/sheet1.xml' },
      { id: 'rId2', type: 'worksheet', target: '/xl/worksheets/sheet2.xml' },
      { id: 'rId3', type: 'sharedStrings', target: 'sharedStrings.xml' },
    ]),
    'xl/sharedStrings.xml': `<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><si><t>Tenant</t></si><si><r><t>Amount</t></r><r><t xml:space="preserve"> "EUR"</t></r><rPh><t>アマウント</t></rPh></si><si><t>Total</t></si></sst>`,
    'xl/worksheets/sheet1.xml': `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${first}</sheetData></worksheet>`,
    'xl/worksheets/sheet2.xml': `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="1"><c r="B1" t="inlineStr"><is><t>Paid on time</t></is></c></row></sheetData></worksheet>`,
  });
}

export interface FixtureImage {
  width: number;
  height: number;
  /** `DeviceGray`, `DeviceRGB`, or `none` for a page with no image. */
  colorSpace: 'DeviceGray' | 'DeviceRGB' | 'none';
  bitsPerComponent: 1 | 8;
  pixels: Uint8Array;
  rotate?: number;
}

/** A PDF of image-only pages (no text layer), one page per image, as a scanner writes it. */
export function scannedPdf(images: readonly FixtureImage[]): Uint8Array<ArrayBuffer> {
  const encoder = new TextEncoder();
  const chunks: Uint8Array[] = [];
  const offsets: number[] = [];
  let length = 0;
  const push = (bytes: string | Uint8Array) => {
    const chunk = typeof bytes === 'string' ? encoder.encode(bytes) : bytes;
    chunks.push(chunk);
    length += chunk.length;
  };
  const object = (id: number, head: string, stream?: Uint8Array) => {
    offsets[id] = length;
    push(`${id} 0 obj\n${head}\n`);
    if (stream) {
      push('stream\n');
      push(stream);
      push('\nendstream\n');
    }
    push('endobj\n');
  };
  push('%PDF-1.4\n');
  const pageIds = images.map((_, index) => 3 + index * 3);
  object(1, '<</Type/Catalog/Pages 2 0 R>>');
  object(
    2,
    `<</Type/Pages/Kids[${pageIds.map((id) => `${id} 0 R`).join(' ')}]/Count ${images.length}>>`,
  );
  for (const [index, image] of images.entries()) {
    const id = 3 + index * 3;
    const content = image.colorSpace === 'none' ? '' : 'q 600 0 0 800 0 0 cm /Im0 Do Q';
    object(
      id,
      `<</Type/Page/Parent 2 0 R/MediaBox[0 0 600 800]${image.rotate ? `/Rotate ${image.rotate}` : ''}/Contents ${id + 1} 0 R/Resources<</XObject<</Im0 ${id + 2} 0 R>>>>>>`,
    );
    object(id + 1, `<</Length ${content.length}>>`, encoder.encode(content));
    const data = deflateSync(image.pixels);
    object(
      id + 2,
      `<</Type/XObject/Subtype/Image/Width ${image.width}/Height ${image.height}/ColorSpace/${
        image.colorSpace === 'none' ? 'DeviceGray' : image.colorSpace
      }/BitsPerComponent ${image.bitsPerComponent}/Filter/FlateDecode/Length ${data.length}>>`,
      data,
    );
  }
  const xref = length;
  const count = 3 + images.length * 3;
  push(`xref\n0 ${count}\n0000000000 65535 f \n`);
  for (let id = 1; id < count; id++) push(`${String(offsets[id]).padStart(10, '0')} 00000 n \n`);
  push(`trailer<</Size ${count}/Root 1 0 R>>\nstartxref\n${xref}\n%%EOF`);
  const pdf = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    pdf.set(chunk, offset);
    offset += chunk.length;
  }
  return pdf;
}

/** A grey page: white paper with dark horizontal "lines of text". */
export function greyPage(width: number, height: number): Uint8Array {
  const pixels = new Uint8Array(width * height).fill(250);
  for (let y = 40; y < height - 40; y += 24) {
    for (let row = y; row < y + 8; row++) {
      for (let x = 40; x < width - 40; x++)
        pixels[row * width + x] = (x * 7 + row) % 5 === 0 ? 90 : 20;
    }
  }
  return pixels;
}

/** The pixels of an 8-bit grey or RGB PNG, unfiltered: proof the encoder wrote a real PNG. */
export function decodePng(png: Uint8Array): {
  width: number;
  height: number;
  channels: number;
  data: Uint8Array;
} {
  const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
  let offset = 8;
  let width = 0;
  let height = 0;
  let channels = 0;
  const idat: Uint8Array[] = [];
  while (offset < png.length) {
    const size = view.getUint32(offset);
    const type = String.fromCharCode(...png.subarray(offset + 4, offset + 8));
    const body = png.subarray(offset + 8, offset + 8 + size);
    if (type === 'IHDR') {
      width = view.getUint32(offset + 8);
      height = view.getUint32(offset + 12);
      channels = body[9] === 0 ? 1 : 3;
    } else if (type === 'IDAT') {
      idat.push(body);
    }
    offset += 12 + size;
  }
  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const data = new Uint8Array(stride * height);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    for (let i = 0; i < stride; i++) {
      const value = raw[y * (stride + 1) + 1 + i];
      const left = i >= channels ? data[y * stride + i - channels] : 0;
      const up = y > 0 ? data[(y - 1) * stride + i] : 0;
      const upLeft = y > 0 && i >= channels ? data[(y - 1) * stride + i - channels] : 0;
      const estimate = left + up - upLeft;
      const paeth =
        Math.abs(estimate - left) <= Math.abs(estimate - up) &&
        Math.abs(estimate - left) <= Math.abs(estimate - upLeft)
          ? left
          : Math.abs(estimate - up) <= Math.abs(estimate - upLeft)
            ? up
            : upLeft;
      const predicted =
        filter === 0 ? 0 : filter === 1 ? left : filter === 2 ? up : filter === 4 ? paeth : NaN;
      data[y * stride + i] = (value + predicted) & 0xff;
    }
  }
  return { width, height, channels, data };
}
