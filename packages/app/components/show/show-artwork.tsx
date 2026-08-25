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

import React from 'react';
import { View } from 'react-native';
import { Image } from 'expo-image';
import { Mic } from 'lucide-react-native';
import { SYRA_API_URL } from '@/lib/config';
import { cn } from '@/lib/utils';

interface ShowArtworkProps {
  /** Syra's image id, or `null` when this show has no cover. */
  assetId: string | null | undefined;
  /** The show's title — the artwork's accessible label. */
  title: string;
  /** Size and corner radius, e.g. `h-16 w-16 rounded-xl`. */
  className: string;
  /** The placeholder glyph, sized for the box the caller asked for. */
  iconSize: number;
}

export function ShowArtwork({ assetId, title, className, iconSize }: ShowArtworkProps) {
  if (assetId === null || assetId === undefined || assetId === '') {
    return (
      <View
        accessibilityRole="image"
        accessibilityLabel={`${title} has no cover art`}
        className={cn('shrink-0 items-center justify-center bg-muted', className)}
      >
        <Mic size={iconSize} className="text-muted-foreground" />
      </View>
    );
  }

  return (
    <Image
      accessibilityRole="image"
      accessibilityLabel={`${title} cover art`}
      source={{ uri: `${SYRA_API_URL}/api/images/${assetId}` }}
      className={cn('shrink-0 bg-muted', className)}
      contentFit="cover"
      transition={150}
    />
  );
}
