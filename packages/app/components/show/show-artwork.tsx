/**
 * A show's cover art.
 *
 * Artwork is the first thing a podcast is, which is why Syra gives it a real
 * size on every surface that names a show — 140px on the show page, 64px in a
 * creator's list — rather than a thumbnail beside a paragraph. Alia's shows are
 * Syra podcasts, so they get the same treatment.
 *
 * ## Why a plain `uri`, and not the Oxy media resolver
 *
 * The cover is drawn at creation and uploaded to SYRA, not to Oxy's file store:
 * `mintCover` in `packages/api/src/routes/shows.ts` calls Syra's
 * `uploadPodcastImage` and keeps SYRA's image id in `coverImageAssetId`. Syra
 * serves it from `GET /api/images/:id`, mounted on its PUBLIC router
 * (`publicApiRouter.use('/images', imagesPublicRoutes)` in `server.ts`), so the
 * request carries no credential and needs none. `oxyServices.getFileDownloadUrl`
 * is the chokepoint for Oxy files; a Syra image is not one, and Syra's own
 * `Artwork` component says the same thing about podcast artwork.
 *
 * A series whose cover could not be drawn has `coverImageAssetId: null` — an
 * account out of credits still gets its show, without art — so the placeholder
 * is a real state and not a loading step.
 */

import { SYRA_API_URL } from '@/lib/config';
import { useTranslation } from '@/lib/hooks/use-translation';
import { Card, type CardRadius } from '@oxy.so/bloom/card';
import { RiMic2Line } from '@oxy.so/bloom/icons/RiMic2Line';
import { useTheme } from '@oxy.so/bloom/theme';
import { Image } from '@/components/ui/image';

interface ShowArtworkProps {
  /** Syra's image id, or `null` when this show has no cover. */
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
 * The tile is Bloom's `Card` (subtle: the fill for a surface sitting on the
 * page), so its colour and corner come from the one place Bloom decides them.
 */
export function ShowArtwork({ assetId, title, size, radius, iconSize }: ShowArtworkProps) {
  const { colors } = useTheme();
  const { t } = useTranslation();
  const hasCover = !(assetId === null || assetId === undefined || assetId === '');

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
          source={{ uri: `${SYRA_API_URL}/api/images/${assetId}` }}
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
