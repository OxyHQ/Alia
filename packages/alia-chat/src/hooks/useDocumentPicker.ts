import * as DocumentPicker from 'expo-document-picker';

export type DocumentPickerResult = {
  uri: string;
  name: string;
  size: number;
  mimeType: string;
};

type UseDocumentPickerResult = {
  pickDocument: () => Promise<DocumentPickerResult[] | undefined>;
};

export function useDocumentPicker(): UseDocumentPickerResult {
  const pickDocument = async (): Promise<DocumentPickerResult[] | undefined> => {
    try {
      const result = await DocumentPicker.getDocumentAsync({
        type: '*/*',
        multiple: true,
        copyToCacheDirectory: true,
      });

      if (result.canceled === false && result.assets && result.assets.length > 0) {
        return result.assets.map((asset) => ({
          uri: asset.uri,
          name: asset.name,
          size: asset.size || 0,
          mimeType: asset.mimeType || 'application/octet-stream',
        }));
      }
    } catch (error) {
      console.warn('Failed to pick document:', error);
    }
  };

  return { pickDocument };
}
