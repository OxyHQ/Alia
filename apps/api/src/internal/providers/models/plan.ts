/**
 * Plan - Subscription plan definitions for Alia and Codea products.
 * Managed via the admin panel and consumed by the billing route and frontend.
 */

import mongoose, { Document, Schema } from 'mongoose';

export interface IFeatureItem {
  label: string;
  description?: string;
}

export interface IFeatureGroup {
  category: string;
  items: IFeatureItem[];
}

export interface IPlan extends Document {
  planId: string;
  name: string;
  product: 'alia' | 'codea';

  // Pricing
  creditsPerMonth: number;
  monthlyPrice: number;
  annualPrice: number;
  currency: string;

  // Display
  subtitle: string;
  creditsLabel: string;
  isFeatured: boolean;
  sortOrder: number;
  features: IFeatureGroup[];

  // Status
  isActive: boolean;
  isFree: boolean;

  // Stripe
  stripeMonthlyPriceId?: string;
  stripeAnnualPriceId?: string;

  // Metadata
  description?: string;
  notes?: string;

  createdAt: Date;
  updatedAt: Date;
}

const FeatureItemSchema = new Schema({
  label: { type: String, required: true },
  description: { type: String },
}, { _id: false });

const FeatureGroupSchema = new Schema({
  category: { type: String, required: true },
  items: { type: [FeatureItemSchema], default: [] },
}, { _id: false });

const PlanSchema = new Schema<IPlan>(
  {
    planId: {
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
    product: {
      type: String,
      required: true,
      enum: ['alia', 'codea'],
    },
    creditsPerMonth: {
      type: Number,
      required: true,
      default: 0,
    },
    monthlyPrice: {
      type: Number,
      required: true,
      default: 0,
    },
    annualPrice: {
      type: Number,
      required: true,
      default: 0,
    },
    currency: {
      type: String,
      required: true,
      default: 'usd',
    },
    subtitle: {
      type: String,
      default: '',
    },
    creditsLabel: {
      type: String,
      default: '',
    },
    isFeatured: {
      type: Boolean,
      default: false,
    },
    sortOrder: {
      type: Number,
      default: 0,
    },
    features: {
      type: [FeatureGroupSchema],
      default: [],
    },
    isActive: {
      type: Boolean,
      default: true,
    },
    isFree: {
      type: Boolean,
      default: false,
    },
    stripeMonthlyPriceId: {
      type: String,
    },
    stripeAnnualPriceId: {
      type: String,
    },
    description: {
      type: String,
      maxlength: 1000,
    },
    notes: {
      type: String,
      maxlength: 2000,
    },
  },
  {
    timestamps: true,
  }
);

PlanSchema.index({ product: 1, sortOrder: 1 });
PlanSchema.index({ product: 1, isActive: 1 });

export const Plan = mongoose.models.Plan || mongoose.model<IPlan>('Plan', PlanSchema);
