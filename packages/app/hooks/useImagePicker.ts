import * as ImagePicker from 'expo-image-picker';
import { toast } from '@/components/sonner';

export type ImagePickerAsset = {
  uri: string;
  name: string;
  size: number;
  mimeType: string;
};

type ImagePickerResult = {
  pickImage: () => Promise<ImagePickerAsset[] | undefined>;
};

export function useImagePicker(): ImagePickerResult {
  const pickImage = async (): Promise<ImagePickerAsset[] | undefined> => {
    try {
      const result = await ImagePicker.launchImageLibraryAsync({
        allowsMultipleSelection: true,
        mediaTypes: ImagePicker.MediaTypeOptions.Images,
        aspect: [4, 3],
        quality: 1,
      });

      if (!result.canceled && result.assets.length > 0) {
        return result.assets.map(asset => ({
          uri: asset.uri,
          name: asset.fileName || `image-${Date.now()}.jpg`,
          size: asset.fileSize || 0,
          mimeType: asset.mimeType || 'image/jpeg',
        }));
      }
    } catch (error) {
      toast.error('Failed to pick image. Please try again.');
    }
  };

  return { pickImage };
} 