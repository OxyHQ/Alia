import type { ComposerPanelAttachment } from '@oxy.so/bloom/composer-panel';
import type { IntakeItem } from '../hooks/useAttachmentIntake';
import type { AliaAttachment } from '../types';
import { MAX_ATTACHMENT_BYTES } from './attachment-intake';
import type { AliaChatLabels } from './labels';

/**
 * The composer's tiles: landed files, then the ones the intake still holds.
 *
 * A file whose read failed, or that was refused, stays in the strip with the
 * sentence that says why — a drop of six where one did not make it is a
 * sentence the user needs beside the five that did, not a toast that slides
 * away. `retryable` marks the ones a second read could fix: a failed read,
 * whose `File` the intake kept. A refusal is not: the same 30 MB file reaches
 * the same verdict — and since Bloom's retry button is the panel's, drawn on
 * every error tile once `onAttachmentRetry` is set, the composer shows a
 * refusal as a toast rather than as a tile it would offer to retry.
 */
export interface ComposerTile extends ComposerPanelAttachment {
  error?: string;
  retryable?: boolean;
}

/** The words a tile and a refusal use. */
type TileLabels = Pick<
  AliaChatLabels,
  'composerUntitled' | 'fileReadFailed' | 'fileTooLarge' | 'fileEmpty' | 'fileUnsupported'
>;

/** Why an intake item is not an attachment, or `undefined` while it is being read. */
export function intakeError(item: IntakeItem, labels: TileLabels): string | undefined {
  const name = item.name || labels.composerUntitled;
  switch (item.status) {
    case 'reading':
      return undefined;
    case 'failed':
      return labels.fileReadFailed(name);
    case 'refused':
      if (item.refusal === 'unsupported') return labels.fileUnsupported(name);
      return item.refusal === 'too-large'
        ? labels.fileTooLarge(name, `${Math.round(MAX_ATTACHMENT_BYTES / (1024 * 1024))} MB`)
        : labels.fileEmpty(name);
  }
}

export function composerTiles(
  attachments: readonly AliaAttachment[],
  items: readonly IntakeItem[],
  labels: TileLabels,
): ComposerTile[] {
  return [
    ...attachments.map((a) => ({
      id: a.id,
      name: a.name,
      kind: a.type === 'image' ? ('image' as const) : ('document' as const),
      src: a.type === 'image' ? a.uri : undefined,
    })),
    ...items.map((item): ComposerTile => {
      const tile: ComposerTile = {
        id: item.id,
        name: item.name || labels.composerUntitled,
        kind: item.kind === 'image' ? 'image' : 'document',
      };
      if (item.status === 'reading') {
        // Real progress only; an unmeasured read is an empty ring, not a guess.
        tile.progress = item.fraction === null ? 0 : Math.round(item.fraction * 100);
        return tile;
      }
      tile.error = intakeError(item, labels);
      tile.retryable = item.status === 'failed';
      return tile;
    }),
  ];
}
