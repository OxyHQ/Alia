import { EmptyState as BloomEmptyState, type EmptyStateProps } from '@oxy.so/bloom/empty-state';
import { EmptyStateSticker } from './empty-state-sticker';
import type { EmptyStateStickerName } from './stickers';

export type AppEmptyStateProps = Omit<EmptyStateProps, 'illustration'> & {
  /** The catalogue sticker drawn above the text; without it the state keeps its icon. */
  sticker?: EmptyStateStickerName;
};

/**
 * Bloom's `EmptyState` with a catalogue sticker as its illustration (which Bloom draws exactly as
 * it comes, and which wins over `icon`). The compact variant is for places too small for a
 * 120-pixel picture and keeps its icon: do not give it a sticker.
 */
export function EmptyState({ sticker, ...props }: AppEmptyStateProps) {
  return (
    <BloomEmptyState
      {...props}
      illustration={sticker === undefined ? undefined : <EmptyStateSticker name={sticker} />}
    />
  );
}
