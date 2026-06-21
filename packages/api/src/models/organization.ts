import mongoose, { Schema, Model, Document } from 'mongoose';

export interface IOrganization extends Document {
  name: string;
  slug: string;
  description?: string;
  image?: string;
  ownerId: mongoose.Types.ObjectId;
  credits: {
    paid: number;
  };
  settings: {
    billingEmail?: string;
    apiCallLimit?: number;
  };
  stripeCustomerId?: string;
  createdAt: Date;
  updatedAt: Date;
}

const OrganizationSchema = new Schema<IOrganization>({
  name: {
    type: String,
    required: true,
  },
  slug: {
    type: String,
    required: true,
    unique: true,
    lowercase: true,
  },
  description: {
    type: String,
  },
  image: {
    type: String,
  },
  ownerId: {
    type: Schema.Types.ObjectId,
    ref: 'User',
    required: true,
  },
  credits: {
    paid: { type: Number, default: 0 },
  },
  settings: {
    billingEmail: { type: String },
    apiCallLimit: { type: Number },
  },
  stripeCustomerId: {
    type: String,
  },
}, {
  timestamps: true,
});

// Indexes (slug is already indexed via unique: true)
OrganizationSchema.index({ ownerId: 1 });

export const Organization: Model<IOrganization> = mongoose.models.Organization || mongoose.model<IOrganization>('Organization', OrganizationSchema);
