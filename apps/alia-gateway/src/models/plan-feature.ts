/**
 * PlanFeature - Junction collection linking Plans to Features.
 * Each document represents a single plan-feature mapping with
 * enabled state, optional limit value, and display overrides.
 */

import mongoose, { Document, Schema } from 'mongoose';

export interface IPlanFeature extends Document {
  planId: string;
  featureId: string;
  enabled: boolean;
  limitValue?: number;
  displayLabel?: string;
  displayDescription?: string;
  createdAt: Date;
  updatedAt: Date;
}

const PlanFeatureSchema = new Schema<IPlanFeature>(
  {
    planId: {
      type: String,
      required: true,
    },
    featureId: {
      type: String,
      required: true,
    },
    enabled: {
      type: Boolean,
      default: true,
    },
    limitValue: {
      type: Number,
    },
    displayLabel: {
      type: String,
    },
    displayDescription: {
      type: String,
    },
  },
  {
    timestamps: true,
  }
);

PlanFeatureSchema.index({ planId: 1, featureId: 1 }, { unique: true });
PlanFeatureSchema.index({ featureId: 1 });

export const PlanFeature = mongoose.models.PlanFeature || mongoose.model<IPlanFeature>('PlanFeature', PlanFeatureSchema);
