import { RiFileTextLine } from '@oxy.so/bloom/icons/RiFileTextLine';
import { RiImageLine } from '@oxy.so/bloom/icons/RiImageLine';
import { useCallback, useMemo } from 'react';
import type { AliaAddMenu } from '../lib/add-menu';
import { loadDocumentPicker } from '../lib/deferred/document-picker';
import type { IntakeKind } from '../lib/attachment-intake';
import { useLabels } from '../lib/labels';
import { ALIA_FEATURES, type FeatureOffer } from '../runtime/agents';
import { type DraftAddress, useComposerDraftStore } from '../runtime/composer-draft-store';
import type { AliaAttachment } from '../types';
import { useImagePicker } from './useImagePicker';

/** What the chat offers to attach: each attachment feature's offer for this lead and person. */
export interface AttachOffers {
  images: FeatureOffer;
  documents: FeatureOffer;
}

const attachmentId = (prefix: string) =>
  `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`;

/**
 * The add menu a host that brings none gets: photos and files, each only where the lead offers it
 * (`featureOffer`). A row the lead's feature gate keeps locked is still shown, and pressing it
 * hands the feature to the host's upsell (`onFeatureLocked`) instead of opening a picker.
 */
export function useAttachMenu(
  address: DraftAddress,
  offers: AttachOffers,
  onFeatureLocked: ((key: string) => void) | undefined,
): AliaAddMenu & { kinds: readonly IntakeKind[] } {
  const labels = useLabels();
  const { pickImage } = useImagePicker();

  const groups = useMemo(() => {
    const rows = [
      ...(offers.images === 'absent'
        ? []
        : [{ id: 'photos', label: labels.addPhotos, icon: RiImageLine }]),
      ...(offers.documents === 'absent'
        ? []
        : [{ id: 'documents', label: labels.addDocuments, icon: RiFileTextLine }]),
    ];
    return rows.length === 0 ? [] : [{ label: labels.addMenuGroup, rows }];
  }, [offers.images, offers.documents, labels.addMenuGroup, labels.addPhotos, labels.addDocuments]);

  /** Dropped and pasted files are held to the same offer: only an available kind is taken. */
  const kinds = useMemo<IntakeKind[]>(
    () => [
      ...(offers.images === 'available' ? (['image'] as const) : []),
      ...(offers.documents === 'available' ? (['document'] as const) : []),
    ],
    [offers.images, offers.documents],
  );

  const onSelect = useCallback(
    async (rowId: string) => {
      const kind = rowId === 'photos' ? 'images' : rowId === 'documents' ? 'documents' : null;
      if (kind === null) return;
      if (offers[kind] === 'locked') {
        onFeatureLocked?.(ALIA_FEATURES[kind]);
        return;
      }
      const store = useComposerDraftStore.getState();
      const picked: AliaAttachment[] =
        kind === 'images'
          ? ((await pickImage()) ?? []).map((asset) => ({
              id: attachmentId('img'),
              type: 'image' as const,
              name: asset.name,
              uri: asset.uri,
              size: asset.size,
              mimeType: asset.mimeType,
            }))
          : // On native the picker loads with the first document: a chat that never attaches one never does.
            ((await (await loadDocumentPicker()).pickDocuments()) ?? []).map((asset) => ({
              id: attachmentId('doc'),
              type: 'document' as const,
              name: asset.name,
              uri: asset.uri,
              size: asset.size,
              mimeType: asset.mimeType,
            }));
      for (const attachment of picked) store.addAttachment(address, attachment);
    },
    [offers, onFeatureLocked, pickImage, address],
  );

  return useMemo(
    () => ({ groups, kinds, onSelect: (rowId: string) => void onSelect(rowId) }),
    [groups, kinds, onSelect],
  );
}
