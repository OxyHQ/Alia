import * as DocumentPicker from 'expo-document-picker';
import { toast } from '@/components/sonner';

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
        return result.assets.map(asset => ({
          uri: asset.uri,
          name: asset.name,
          size: asset.size || 0,
          mimeType: asset.mimeType || 'application/octet-stream',
        }));
      }
    } catch (error) {
      toast.error('Failed to pick document. Please try again.');
    }
  };

  return { pickDocument };
}
