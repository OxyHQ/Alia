/**
 * Seed script: Register default accessories in the catalog and upload PNGs to S3
 *
 * Usage: npx tsx src/scripts/seed-accessories.ts
 *
 * - Reads PNGs from the app's assets/accessories/ directory
 * - Uploads each to S3 under {env}/accessories/{slug}.png (deterministic key)
 * - Upserts accessory documents by slug with the S3 URL
 * - Safe to run multiple times — deterministic keys overwrite, upsert by slug
 */

import mongoose from 'mongoose';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { Accessory } from '../models/accessory.js';
import { uploadToS3Deterministic } from '../lib/s3.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const MONGODB_URI = process.env.MONGODB_URI!;
const NODE_ENV = process.env.NODE_ENV || 'development';
const DB_NAME = `alia-${NODE_ENV}`;

/** Path to bundled accessory PNGs */
const ASSETS_DIR = path.resolve(__dirname, '../../../app/assets/accessories');

type AccessorySlot = 'head' | 'face' | 'neck';
type AccessoryLayer = 'front' | 'behind';
type AccessoryRarity = 'common' | 'uncommon' | 'rare' | 'legendary';

interface SeedAccessory {
  name: string;
  slug: string;
  slot: AccessorySlot;
  layer: AccessoryLayer;
  /** Filename in assets/accessories/ (also used as S3 key suffix) */
  filename: string;
  price: number;
  rarity: AccessoryRarity;
  isDefault: boolean;
}

const DEFAULT_ACCESSORIES: SeedAccessory[] = [
  { name: 'Top Hat', slug: 'head-tophat', slot: 'head', layer: 'front', filename: 'head-tophat.png', price: 0, rarity: 'common', isDefault: true },
  { name: 'Headphones', slug: 'head-headphones', slot: 'head', layer: 'behind', filename: 'head-headphones.png', price: 0, rarity: 'common', isDefault: true },
  { name: 'Crown', slug: 'head-crown', slot: 'head', layer: 'front', filename: 'head-crown.png', price: 0, rarity: 'uncommon', isDefault: true },
  { name: 'Glasses', slug: 'face-glasses', slot: 'face', layer: 'front', filename: 'face-glasses.png', price: 0, rarity: 'common', isDefault: true },
  { name: 'Sunglasses', slug: 'face-sunglasses', slot: 'face', layer: 'front', filename: 'face-sunglasses.png', price: 0, rarity: 'common', isDefault: true },
  { name: 'Tie', slug: 'neck-tie', slot: 'neck', layer: 'front', filename: 'neck-tie.png', price: 0, rarity: 'common', isDefault: true },
  { name: 'Bow Tie', slug: 'neck-bowtie', slot: 'neck', layer: 'front', filename: 'neck-bowtie.png', price: 0, rarity: 'common', isDefault: true },
  { name: 'Apple', slug: 'head-apple', slot: 'head', layer: 'front', filename: 'head-apple.png', price: 0, rarity: 'common', isDefault: true },
  { name: 'Scarf', slug: 'neck-scarf', slot: 'neck', layer: 'front', filename: 'neck-scarf.png', price: 0, rarity: 'common', isDefault: true },
  { name: 'Firefighter Helmet', slug: 'head-firefighter-helmet', slot: 'head', layer: 'front', filename: 'head-firefighter-helmet.png', price: 0, rarity: 'uncommon', isDefault: true },
  { name: 'Cat', slug: 'head-cat', slot: 'head', layer: 'front', filename: 'head-cat.png', price: 0, rarity: 'common', isDefault: true },
  { name: 'Blue Crown', slug: 'head-blue-crown', slot: 'head', layer: 'front', filename: 'head-blue-crown.png', price: 0, rarity: 'uncommon', isDefault: true },
  { name: 'Rubber Duck', slug: 'head-duck', slot: 'head', layer: 'front', filename: 'head-duck.png', price: 0, rarity: 'common', isDefault: true },
  { name: 'Flower', slug: 'head-flower', slot: 'head', layer: 'front', filename: 'head-flower.png', price: 0, rarity: 'common', isDefault: true },
  { name: 'Propeller Hat', slug: 'head-propeller-hat', slot: 'head', layer: 'front', filename: 'head-propeller-hat.png', price: 0, rarity: 'uncommon', isDefault: true },
  { name: 'Cowboy Hat', slug: 'head-cowboy-hat', slot: 'head', layer: 'front', filename: 'head-cowboy-hat.png', price: 0, rarity: 'common', isDefault: true },
  { name: 'Leaf', slug: 'head-leaf', slot: 'head', layer: 'front', filename: 'head-leaf.png', price: 0, rarity: 'common', isDefault: true },
  { name: 'Ribbon', slug: 'head-ribbon', slot: 'head', layer: 'front', filename: 'head-ribbon.png', price: 0, rarity: 'common', isDefault: true },
  { name: 'Pencil', slug: 'head-pencil', slot: 'head', layer: 'front', filename: 'head-pencil.png', price: 0, rarity: 'common', isDefault: true },
  { name: 'Pepper', slug: 'head-pepper', slot: 'head', layer: 'front', filename: 'head-pepper.png', price: 0, rarity: 'uncommon', isDefault: true },
];

async function main() {
  console.log(`Connecting to ${DB_NAME}...`);
  await mongoose.connect(MONGODB_URI, { dbName: DB_NAME });
  console.log('Connected.\n');

  console.log(`Reading PNGs from ${ASSETS_DIR}`);
  console.log(`Uploading to S3 under ${NODE_ENV}/accessories/\n`);

  // Upload all PNGs to S3 in parallel, returning { acc, imageUrl } tuples
  const uploads = await Promise.all(
    DEFAULT_ACCESSORIES.map(async (acc) => {
      const filePath = path.join(ASSETS_DIR, acc.filename);
      try {
        const buffer = await fs.promises.readFile(filePath);
        const key = `${NODE_ENV}/accessories/${acc.slug}.png`;
        const imageUrl = await uploadToS3Deterministic(buffer, key, 'image/png');
        console.log(`  ↑ S3: ${key}`);
        return { acc, imageUrl };
      } catch {
        console.warn(`  ⚠ PNG not found: ${filePath} — using filename as fallback`);
        return { acc, imageUrl: acc.filename };
      }
    })
  );

  // Upsert all catalog entries in a single bulkWrite
  const ops = uploads.map(({ acc, imageUrl }) => ({
    updateOne: {
      filter: { slug: acc.slug },
      update: {
        $set: {
          name: acc.name,
          slug: acc.slug,
          slot: acc.slot,
          layer: acc.layer,
          imageUrl,
          price: acc.price,
          rarity: acc.rarity,
          isDefault: acc.isDefault,
          isPublished: true,
        },
      },
      upsert: true,
    },
  }));
  await Accessory.bulkWrite(ops);

  for (const { acc } of uploads) {
    console.log(`  ✓ ${acc.slug} — ${acc.name}`);
  }

  console.log(`\nSeeded ${DEFAULT_ACCESSORIES.length} accessories.`);
  await mongoose.disconnect();
}

main().catch((err) => {
  console.error('Seed failed:', err);
  process.exit(1);
});
