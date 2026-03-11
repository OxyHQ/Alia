import { ImageSourcePropType } from 'react-native';

// ── Types ────────────────────────────────────────────────────────────────────

export type AccessorySlot = 'head' | 'face' | 'neck';
export type AccessoryLayer = 'front' | 'behind';

export interface Accessory {
  /** Visual slot on the face (head, face, neck) — reserved for future slot-based logic */
  slot: AccessorySlot;
  /** Render layer: 'behind' renders under the face circle, 'front' renders on top */
  layer: AccessoryLayer;
  /** The accessory image (full circle size, pre-positioned within the PNG) */
  image: ImageSourcePropType;
  /** Position offsets as ratio of circle size (0-1) — reserved for future fine-tuning */
  position: { top: number; left: number; width: number; height: number };
}

// ── Registry ─────────────────────────────────────────────────────────────────
// Each PNG is the full circle size with the accessory pre-positioned.
// To add a new accessory: drop a same-size transparent PNG + add one entry here.

export const ACCESSORIES: Record<string, Accessory> = {
  'head-tophat': {
    slot: 'head',
    layer: 'front',
    image: require('@/assets/accessories/head-tophat.png'),
    position: { top: 0, left: 0, width: 1, height: 1 },
  },
  'head-headphones': {
    slot: 'head',
    layer: 'behind',
    image: require('@/assets/accessories/head-headphones.png'),
    position: { top: 0, left: 0, width: 1, height: 1 },
  },
  'head-crown': {
    slot: 'head',
    layer: 'front',
    image: require('@/assets/accessories/head-crown.png'),
    position: { top: 0, left: 0, width: 1, height: 1 },
  },
  'face-glasses': {
    slot: 'face',
    layer: 'front',
    image: require('@/assets/accessories/face-glasses.png'),
    position: { top: 0, left: 0, width: 1, height: 1 },
  },
  'face-sunglasses': {
    slot: 'face',
    layer: 'front',
    image: require('@/assets/accessories/face-sunglasses.png'),
    position: { top: 0, left: 0, width: 1, height: 1 },
  },
  'neck-tie': {
    slot: 'neck',
    layer: 'front',
    image: require('@/assets/accessories/neck-tie.png'),
    position: { top: 0, left: 0, width: 1, height: 1 },
  },
  'neck-bowtie': {
    slot: 'neck',
    layer: 'front',
    image: require('@/assets/accessories/neck-bowtie.png'),
    position: { top: 0, left: 0, width: 1, height: 1 },
  },
  'head-apple': {
    slot: 'head',
    layer: 'front',
    image: require('@/assets/accessories/head-apple.png'),
    position: { top: 0, left: 0, width: 1, height: 1 },
  },
  'neck-scarf': {
    slot: 'neck',
    layer: 'front',
    image: require('@/assets/accessories/neck-scarf.png'),
    position: { top: 0, left: 0, width: 1, height: 1 },
  },
  'head-firefighter-helmet': {
    slot: 'head',
    layer: 'front',
    image: require('@/assets/accessories/head-firefighter-helmet.png'),
    position: { top: 0, left: 0, width: 1, height: 1 },
  },
  'head-cat': {
    slot: 'head',
    layer: 'front',
    image: require('@/assets/accessories/head-cat.png'),
    position: { top: 0, left: 0, width: 1, height: 1 },
  },
  'head-blue-crown': {
    slot: 'head',
    layer: 'front',
    image: require('@/assets/accessories/head-blue-crown.png'),
    position: { top: 0, left: 0, width: 1, height: 1 },
  },
  'head-duck': {
    slot: 'head',
    layer: 'front',
    image: require('@/assets/accessories/head-duck.png'),
    position: { top: 0, left: 0, width: 1, height: 1 },
  },
  'head-flower': {
    slot: 'head',
    layer: 'front',
    image: require('@/assets/accessories/head-flower.png'),
    position: { top: 0, left: 0, width: 1, height: 1 },
  },
  'head-propeller-hat': {
    slot: 'head',
    layer: 'front',
    image: require('@/assets/accessories/head-propeller-hat.png'),
    position: { top: 0, left: 0, width: 1, height: 1 },
  },
  'head-cowboy-hat': {
    slot: 'head',
    layer: 'front',
    image: require('@/assets/accessories/head-cowboy-hat.png'),
    position: { top: 0, left: 0, width: 1, height: 1 },
  },
  'head-leaf': {
    slot: 'head',
    layer: 'front',
    image: require('@/assets/accessories/head-leaf.png'),
    position: { top: 0, left: 0, width: 1, height: 1 },
  },
  'head-ribbon': {
    slot: 'head',
    layer: 'front',
    image: require('@/assets/accessories/head-ribbon.png'),
    position: { top: 0, left: 0, width: 1, height: 1 },
  },
  'head-pencil': {
    slot: 'head',
    layer: 'front',
    image: require('@/assets/accessories/head-pencil.png'),
    position: { top: 0, left: 0, width: 1, height: 1 },
  },
  'head-pepper': {
    slot: 'head',
    layer: 'front',
    image: require('@/assets/accessories/head-pepper.png'),
    position: { top: 0, left: 0, width: 1, height: 1 },
  },
};

// ── Helpers ──────────────────────────────────────────────────────────────────

export function getAccessory(id: string): Accessory | undefined {
  return ACCESSORIES[id];
}

/**
 * Resolve an accessory image source by slug, with optional remote URL fallback.
 * - Bundled accessories resolve instantly (no network)
 * - Unknown slugs fall back to the S3 URL from the catalog
 */
export function getAccessoryImage(
  slug: string,
  remoteUrl?: string,
): ImageSourcePropType | undefined {
  const local = ACCESSORIES[slug];
  if (local) return local.image;
  if (remoteUrl) return { uri: remoteUrl };
  return undefined;
}

