import * as ImagePicker from 'expo-image-picker';
import { toast } from '@/components/sonner';

type ImagePickerResult = {
  pickImage: () => Promise<string[] | undefined>;
};

export function useImagePicker(): ImagePickerResult {
  const pickImage = async (): Promise<string[] | undefined> => {
    try {
      const result = await ImagePicker.launchImageLibraryAsync({
        allowsMultipleSelection: true,
        mediaTypes: ImagePicker.MediaTypeOptions.Images,
        aspect: [4, 3],
        quality: 1,
      });

      if (!result.canceled && result.assets.length > 0) {
        return result.assets.map(asset => asset.uri);
      }
    } catch (error) {
      toast.error('Failed to pick image. Please try again.');
    }
  };

  return { pickImage };
} 