import { RiImageLine } from '@oxy.so/bloom/icons/RiImageLine';
import { useCallback, useMemo } from 'react';
import type { AliaAddMenu } from '../lib/add-menu';
import { useLabels } from '../lib/labels';
import { type DraftAddress, useComposerDraftStore } from '../runtime/composer-draft-store';
import { useImagePicker } from './useImagePicker';

/**
 * The add menu a host that brings none gets: photos, the one attachment the chat API carries
 * (`image_url` parts). A picked photo becomes an attachment of the draft at `address`.
 */
export function usePhotosMenu(address: DraftAddress): AliaAddMenu {
  const labels = useLabels();
  const { pickImage } = useImagePicker();

  const groups = useMemo(
    () => [
      {
        label: labels.addMenuGroup,
        rows: [{ id: 'photos', label: labels.addPhotos, icon: RiImageLine }],
      },
    ],
    [labels.addMenuGroup, labels.addPhotos],
  );

  const onSelect = useCallback(
    async (rowId: string) => {
      if (rowId !== 'photos') return;
      const assets = await pickImage();
      if (!assets?.length) return;
      const store = useComposerDraftStore.getState();
      for (const asset of assets) {
        store.addAttachment(address, {
          id: `img-${Date.now()}-${Math.random().toString(36).slice(2)}`,
          type: 'image' as const,
          name: asset.name,
          uri: asset.uri,
          size: asset.size,
          mimeType: asset.mimeType,
        });
      }
    },
    [pickImage, address],
  );

  return useMemo(() => ({ groups, onSelect: (rowId) => void onSelect(rowId) }), [groups, onSelect]);
}
