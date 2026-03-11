/**
 * Seed script: Register default accessories in the catalog
 *
 * Usage: npx tsx src/scripts/seed-accessories.ts
 *
 * Upserts accessory documents so all users have the default set.
 * Safe to run multiple times — uses upsert by _id.
 */

import mongoose from 'mongoose';
import { Accessory, type IAccessory } from '../models/accessory.js';

const MONGODB_URI = process.env.MONGODB_URI!;
const NODE_ENV = process.env.NODE_ENV || 'development';
const DB_NAME = `alia-${NODE_ENV}`;

type AccessorySlot = 'head' | 'face' | 'neck';
type AccessoryLayer = 'front' | 'behind';
type AccessoryRarity = 'common' | 'uncommon' | 'rare' | 'legendary';

interface SeedAccessory {
  _id: string;
  name: string;
  slug: string;
  slot: AccessorySlot;
  layer: AccessoryLayer;
  imageUrl: string;
  price: number;
  rarity: AccessoryRarity;
  isDefault: boolean;
}

// Default accessories — free for all users
// imageUrl references the bundled asset name (used by the app's local registry)
const DEFAULT_ACCESSORIES: SeedAccessory[] = [
  {
    _id: 'head-tophat',
    name: 'Top Hat',
    slug: 'head-tophat',
    slot: 'head',
    layer: 'front',
    imageUrl: 'head-tophat.png',
    price: 0,
    rarity: 'common',
    isDefault: true,
  },
  {
    _id: 'head-headphones',
    name: 'Headphones',
    slug: 'head-headphones',
    slot: 'head',
    layer: 'behind',
    imageUrl: 'head-headphones.png',
    price: 0,
    rarity: 'common',
    isDefault: true,
  },
  {
    _id: 'head-crown',
    name: 'Crown',
    slug: 'head-crown',
    slot: 'head',
    layer: 'front',
    imageUrl: 'head-crown.png',
    price: 0,
    rarity: 'uncommon',
    isDefault: true,
  },
  {
    _id: 'face-glasses',
    name: 'Glasses',
    slug: 'face-glasses',
    slot: 'face',
    layer: 'front',
    imageUrl: 'face-glasses.png',
    price: 0,
    rarity: 'common',
    isDefault: true,
  },
  {
    _id: 'face-sunglasses',
    name: 'Sunglasses',
    slug: 'face-sunglasses',
    slot: 'face',
    layer: 'front',
    imageUrl: 'face-sunglasses.png',
    price: 0,
    rarity: 'common',
    isDefault: true,
  },
  {
    _id: 'neck-tie',
    name: 'Tie',
    slug: 'neck-tie',
    slot: 'neck',
    layer: 'front',
    imageUrl: 'neck-tie.png',
    price: 0,
    rarity: 'common',
    isDefault: true,
  },
  {
    _id: 'neck-bowtie',
    name: 'Bow Tie',
    slug: 'neck-bowtie',
    slot: 'neck',
    layer: 'front',
    imageUrl: 'neck-bowtie.png',
    price: 0,
    rarity: 'common',
    isDefault: true,
  },
];

async function main() {
  console.log(`Connecting to ${DB_NAME}...`);
  await mongoose.connect(MONGODB_URI, { dbName: DB_NAME });
  console.log('Connected.');

  for (const acc of DEFAULT_ACCESSORIES) {
    const result = await Accessory.findByIdAndUpdate(
      acc._id,
      { $set: { ...acc, isPublished: true } },
      { upsert: true, returnDocument: 'after' }
    );
    console.log(`  ✓ ${result!._id} — ${result!.name}`);
  }

  console.log(`\nSeeded ${DEFAULT_ACCESSORIES.length} accessories.`);
  await mongoose.disconnect();
}

main().catch((err) => {
  console.error('Seed failed:', err);
  process.exit(1);
});
