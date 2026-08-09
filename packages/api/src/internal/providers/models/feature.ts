/**
 * Feature - Canonical feature definitions for plan comparison and entitlements.
 * Each feature has a unique slug (featureId), a type (boolean or limit),
 * and a category for grouping on the pricing page.
 */

import mongoose, { Document, Schema } from 'mongoose';

/**
 * Whether a feature is a yes/no entitlement or a numeric allowance. A `limit`
 * feature is the only kind for which `PlanFeature.limitValue` is meaningful.
 */
export const FEATURE_TYPES = ['boolean', 'limit'] as const;
export type FeatureType = (typeof FEATURE_TYPES)[number];

export interface IFeature extends Document {
  featureId: string;
  label: string;
  description?: string;
  icon?: string;
  category: string;
  featureType: 'boolean' | 'limit';
  sortOrder: number;
  isVisibleOnPricing: boolean;
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
}

const FeatureSchema = new Schema<IFeature>(
  {
    featureId: {
      type: String,
      required: true,
      unique: true,
      index: true,
      lowercase: true,
    },
    label: {
      type: String,
      required: true,
    },
    description: {
      type: String,
    },
    icon: {
      type: String,
    },
    category: {
      type: String,
      required: true,
    },
    featureType: {
      type: String,
      required: true,
      enum: [...FEATURE_TYPES],
      default: 'boolean',
    },
    sortOrder: {
      type: Number,
      default: 0,
    },
    isVisibleOnPricing: {
      type: Boolean,
      default: true,
    },
    isActive: {
      type: Boolean,
      default: true,
    },
  },
  {
    timestamps: true,
  }
);

FeatureSchema.index({ category: 1, sortOrder: 1 });

export const Feature = (mongoose.models.Feature || mongoose.model<IFeature>('Feature', FeatureSchema)) as mongoose.Model<IFeature>;
