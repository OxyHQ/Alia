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
};

// ── Helpers ──────────────────────────────────────────────────────────────────

export function getAccessory(id: string): Accessory | undefined {
  return ACCESSORIES[id];
}

