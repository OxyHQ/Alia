import * as ImagePicker from 'expo-image-picker';
import { toast } from '@oxyhq/bloom/toast';

export type ImagePickerAsset = {
  uri: string;
  name: string;
  size: number;
  mimeType: string;
};

type ImagePickerResult = {
  pickImage: () => Promise<ImagePickerAsset[] | undefined>;
  takePhoto: () => Promise<ImagePickerAsset[] | undefined>;
};

function toImagePickerAsset(asset: ImagePicker.ImagePickerAsset): ImagePickerAsset {
  return {
    uri: asset.uri,
    name: asset.fileName || `image-${Date.now()}.jpg`,
    size: asset.fileSize || 0,
    mimeType: asset.mimeType || 'image/jpeg',
  };
}

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
        return result.assets.map(toImagePickerAsset);
      }
    } catch {
      toast.error('Failed to pick image. Please try again.');
    }
  };

  const takePhoto = async (): Promise<ImagePickerAsset[] | undefined> => {
    try {
      const permission = await ImagePicker.requestCameraPermissionsAsync();
      if (!permission.granted) {
        toast.error('Camera access is required to take a photo.');
        return;
      }

      const result = await ImagePicker.launchCameraAsync({
        mediaTypes: ImagePicker.MediaTypeOptions.Images,
        quality: 1,
      });
      if (!result.canceled && result.assets.length > 0) {
        return result.assets.map(toImagePickerAsset);
      }
    } catch {
      toast.error('Failed to take a photo. Please try again.');
    }
  };

  return { pickImage, takePhoto };
}
