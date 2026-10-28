import { extractText, getDocumentProxy } from 'unpdf';

/** The text of a PDF, its pages joined. */
export async function pdfText(bytes: Uint8Array): Promise<string> {
  const document = await getDocumentProxy(bytes, { verbosity: 0 });
  try {
    const { text } = await extractText(document, { mergePages: true });
    return text;
  } finally {
    await document.loadingTask.destroy();
  }
}
