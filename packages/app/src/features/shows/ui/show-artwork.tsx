/**
 * A show's cover art.
 *
 * Artwork is the first thing a podcast is, which is why Syra gives it a real
 * size on every surface that names a show — 140px on the show page, 64px in a
 * creator's list — rather than a thumbnail beside a paragraph. Alia's shows are
 * Syra podcasts, so they get the same treatment.
 *
 * ## Where the cover comes from
 *
 * Alia draws the cover and stores it as ALIA's own public file in Oxy Files
 * (`packages/api/src/lib/files/oxy-files.ts`); Syra is handed the same file id
 * as the podcast's artwork. So `coverFileId` is an Oxy file id, and it is
 * resolved through the app's ONE image chokepoint — Bloom's image resolver,
 * which `app/_layout.tsx` binds to `oxyServices.assets.publicUrl` — never by
 * building a CDN address here.
 *
 * ## The legacy cover, while series move
 *
 * Series made before covers moved hold `coverImageAssetId`: SYRA's image id,
 * served from Syra's PUBLIC `GET /api/images/:id`, which needs no credential.
 * It is read only when there is no `coverFileId` (the dual read of
 * `docs/oxy-files.md`), and it goes away once every series has moved.
 *
 * A series whose cover could not be drawn has neither — an account out of
 * credits still gets its show, without art — so the placeholder is a real state
 * and not a loading step.
 */

import { SYRA_API_URL } from '@/shared/platform/config';
import { useTranslation } from '@/shared/i18n/use-translation';
import { Card, type CardRadius } from '@oxy.so/bloom/card';
import { useImageResolver } from '@oxy.so/bloom/image-resolver';
import { RiMic2Line } from '@oxy.so/bloom/icons/RiMic2Line';
import { useTheme } from '@oxy.so/bloom/theme';
import { Image } from '@/shared/ui/image';

interface ShowArtworkProps {
  /** The cover as an Oxy file id, or `null` when it has none. Read first. */
  fileId?: string | null | undefined;
  /** Syra's legacy image id, read only when there is no `fileId`. */
  assetId: string | null | undefined;
  /** The show's title — the artwork's accessible label. */
  title: string;
  /** The square's side, in px. */
  size: number;
  /** The tile's corner, as a rung of Bloom's radius scale. */
  radius: CardRadius;
  /** The placeholder glyph, sized for the box the caller asked for. */
  iconSize: number;
}

/**
 * The Oxy rendition for a square of `size` layout pixels: the smallest one at
 * least three device pixels per layout pixel wide, so a 64px tile asks for the
 * 256px `thumb` and the show page's hero for `w640`, never the original.
 */
export function coverVariantFor(size: number): string {
  const physical = size * 3;
  if (physical <= 256) return 'thumb';
  if (physical <= 640) return 'w640';
  return 'w1280';
}

function present(value: string | null | undefined): value is string {
  return value !== null && value !== undefined && value !== '';
}

/**
 * The tile is Bloom's `Card` (subtle: the fill for a surface sitting on the
 * page), so its colour and corner come from the one place Bloom decides them.
 */
export function ShowArtwork({ fileId, assetId, title, size, radius, iconSize }: ShowArtworkProps) {
  const { colors } = useTheme();
  const { t } = useTranslation();
  const resolve = useImageResolver();

  const uri = present(fileId)
    ? (resolve?.(fileId, coverVariantFor(size)) ?? undefined)
    : present(assetId)
      ? `${SYRA_API_URL}/api/images/${assetId}`
      : undefined;
  const hasCover = uri !== undefined;

  return (
    <Card
      appearance="subtle"
      radius={radius}
      accessibilityLabel={hasCover ? undefined : t('shows.noCoverArt', { title })}
      className="shrink-0 items-center justify-center"
      // The side is the caller's number (64 in a list, larger on the show page).
      style={{ width: size, height: size }}
    >
      {hasCover ? (
        <Image
          accessibilityRole="image"
          accessibilityLabel={t('shows.coverArt', { title })}
          source={{ uri }}
          className="h-full w-full"
          contentFit="cover"
          transition={150}
        />
      ) : (
        <RiMic2Line width={iconSize} height={iconSize} fill={colors.textSecondary} />
      )}
    </Card>
  );
}
