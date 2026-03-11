/**
 * Seed script: Register default accessories in the catalog
 *
 * Usage: npx tsx src/scripts/seed-accessories.ts
 *
 * Upserts accessory documents by slug so all users have the default set.
 * Safe to run multiple times — uses upsert by slug.
 */

import mongoose from 'mongoose';
import { Accessory } from '../models/accessory.js';

const MONGODB_URI = process.env.MONGODB_URI!;
const NODE_ENV = process.env.NODE_ENV || 'development';
const DB_NAME = `alia-${NODE_ENV}`;

type AccessorySlot = 'head' | 'face' | 'neck';
type AccessoryLayer = 'front' | 'behind';
type AccessoryRarity = 'common' | 'uncommon' | 'rare' | 'legendary';

interface SeedAccessory {
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
    name: 'Bow Tie',
    slug: 'neck-bowtie',
    slot: 'neck',
    layer: 'front',
    imageUrl: 'neck-bowtie.png',
    price: 0,
    rarity: 'common',
    isDefault: true,
  },
  {
    name: 'Apple',
    slug: 'head-apple',
    slot: 'head',
    layer: 'front',
    imageUrl: 'head-apple.png',
    price: 0,
    rarity: 'common',
    isDefault: true,
  },
  {
    name: 'Scarf',
    slug: 'neck-scarf',
    slot: 'neck',
    layer: 'front',
    imageUrl: 'neck-scarf.png',
    price: 0,
    rarity: 'common',
    isDefault: true,
  },
  {
    name: 'Firefighter Helmet',
    slug: 'head-firefighter-helmet',
    slot: 'head',
    layer: 'front',
    imageUrl: 'head-firefighter-helmet.png',
    price: 0,
    rarity: 'uncommon',
    isDefault: true,
  },
  {
    name: 'Cat',
    slug: 'head-cat',
    slot: 'head',
    layer: 'front',
    imageUrl: 'head-cat.png',
    price: 0,
    rarity: 'common',
    isDefault: true,
  },
  {
    name: 'Blue Crown',
    slug: 'head-blue-crown',
    slot: 'head',
    layer: 'front',
    imageUrl: 'head-blue-crown.png',
    price: 0,
    rarity: 'uncommon',
    isDefault: true,
  },
  {
    name: 'Rubber Duck',
    slug: 'head-duck',
    slot: 'head',
    layer: 'front',
    imageUrl: 'head-duck.png',
    price: 0,
    rarity: 'common',
    isDefault: true,
  },
  {
    name: 'Flower',
    slug: 'head-flower',
    slot: 'head',
    layer: 'front',
    imageUrl: 'head-flower.png',
    price: 0,
    rarity: 'common',
    isDefault: true,
  },
  {
    name: 'Propeller Hat',
    slug: 'head-propeller-hat',
    slot: 'head',
    layer: 'front',
    imageUrl: 'head-propeller-hat.png',
    price: 0,
    rarity: 'uncommon',
    isDefault: true,
  },
  {
    name: 'Cowboy Hat',
    slug: 'head-cowboy-hat',
    slot: 'head',
    layer: 'front',
    imageUrl: 'head-cowboy-hat.png',
    price: 0,
    rarity: 'common',
    isDefault: true,
  },
  {
    name: 'Leaf',
    slug: 'head-leaf',
    slot: 'head',
    layer: 'front',
    imageUrl: 'head-leaf.png',
    price: 0,
    rarity: 'common',
    isDefault: true,
  },
  {
    name: 'Ribbon',
    slug: 'head-ribbon',
    slot: 'head',
    layer: 'front',
    imageUrl: 'head-ribbon.png',
    price: 0,
    rarity: 'common',
    isDefault: true,
  },
  {
    name: 'Pencil',
    slug: 'head-pencil',
    slot: 'head',
    layer: 'front',
    imageUrl: 'head-pencil.png',
    price: 0,
    rarity: 'common',
    isDefault: true,
  },
  {
    name: 'Pepper',
    slug: 'head-pepper',
    slot: 'head',
    layer: 'front',
    imageUrl: 'head-pepper.png',
    price: 0,
    rarity: 'uncommon',
    isDefault: true,
  },
];

async function main() {
  console.log(`Connecting to ${DB_NAME}...`);
  await mongoose.connect(MONGODB_URI, { dbName: DB_NAME });
  console.log('Connected.');

  for (const acc of DEFAULT_ACCESSORIES) {
    const result = await Accessory.findOneAndUpdate(
      { slug: acc.slug },
      { $set: { ...acc, isPublished: true } },
      { upsert: true, returnDocument: 'after' }
    );
    console.log(`  ✓ ${result!.slug} (${result!._id}) — ${result!.name}`);
  }

  console.log(`\nSeeded ${DEFAULT_ACCESSORIES.length} accessories.`);
  await mongoose.disconnect();
}

main().catch((err) => {
  console.error('Seed failed:', err);
  process.exit(1);
});
