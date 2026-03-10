/**
 * CreditPackage - One-time credit purchase packages.
 * Managed via the admin panel, consumed by the billing route.
 */

import mongoose, { Document, Schema } from 'mongoose';

export interface ICreditPackage extends Document {
  packageId: string;
  name: string;
  credits: number;
  price: number;         // in cents
  currency: string;
  stripePriceId?: string;
  sortOrder: number;
  isActive: boolean;
  description?: string;
  createdAt: Date;
  updatedAt: Date;
}

const CreditPackageSchema = new Schema<ICreditPackage>(
  {
    packageId: {
      type: String,
      required: true,
      unique: true,
      index: true,
      lowercase: true,
    },
    name: {
      type: String,
      required: true,
    },
    credits: {
      type: Number,
      required: true,
      min: 1,
    },
    price: {
      type: Number,
      required: true,
      min: 0,
    },
    currency: {
      type: String,
      required: true,
      default: 'usd',
    },
    stripePriceId: {
      type: String,
    },
    sortOrder: {
      type: Number,
      default: 0,
    },
    isActive: {
      type: Boolean,
      default: true,
    },
    description: {
      type: String,
      maxlength: 1000,
    },
  },
  {
    timestamps: true,
  }
);

CreditPackageSchema.index({ isActive: 1, sortOrder: 1 });

export const CreditPackage = (mongoose.models.CreditPackage || mongoose.model<ICreditPackage>('CreditPackage', CreditPackageSchema)) as mongoose.Model<ICreditPackage>;
