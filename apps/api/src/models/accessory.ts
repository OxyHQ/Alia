import mongoose, { Schema, Model, Document } from 'mongoose';

export type AccessorySlot = 'head' | 'face' | 'neck';
export type AccessoryLayer = 'front' | 'behind';
export type AccessoryRarity = 'common' | 'uncommon' | 'rare' | 'legendary';

export interface IAccessory extends Document<string> {
  _id: string;
  name: string;
  slug: string;
  slot: AccessorySlot;
  layer: AccessoryLayer;
  imageUrl: string;
  thumbnailUrl?: string;
  price: number;
  rarity: AccessoryRarity;
  isDefault: boolean;
  isPublished: boolean;
  createdAt: Date;
  updatedAt: Date;
}

const AccessorySchema = new Schema<IAccessory>({
  _id: { type: String, required: true },
  name: { type: String, required: true },
  slug: { type: String, required: true, unique: true },
  slot: { type: String, enum: ['head', 'face', 'neck'], required: true },
  layer: { type: String, enum: ['front', 'behind'], required: true },
  imageUrl: { type: String, required: true },
  thumbnailUrl: { type: String },
  price: { type: Number, default: 0, min: 0 },
  rarity: { type: String, enum: ['common', 'uncommon', 'rare', 'legendary'], default: 'common' },
  isDefault: { type: Boolean, default: false },
  isPublished: { type: Boolean, default: true },
}, {
  timestamps: true,
});

AccessorySchema.index({ slot: 1 });
AccessorySchema.index({ isPublished: 1 });

export const Accessory: Model<IAccessory> =
  mongoose.models.Accessory || mongoose.model<IAccessory>('Accessory', AccessorySchema);
