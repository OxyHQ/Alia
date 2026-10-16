import { type DocumentPickerResult, pickDocuments } from '../lib/document-picker';

export type { DocumentPickerResult };

type UseDocumentPickerResult = {
  pickDocument: () => Promise<DocumentPickerResult[] | undefined>;
};

export function useDocumentPicker(): UseDocumentPickerResult {
  return { pickDocument: pickDocuments };
}
