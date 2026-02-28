import mongoose, { Schema, Model, Document } from 'mongoose';

export type InviteStatus = 'pending' | 'accepted' | 'declined' | 'expired';

export interface IOrganizationInvite extends Document {
  organizationId: mongoose.Types.ObjectId;
  email?: string;
  role: 'admin' | 'member';
  token: string;
  invitedBy: mongoose.Types.ObjectId;
  status: InviteStatus;
  expiresAt: Date;
  acceptedAt?: Date;
  acceptedBy?: mongoose.Types.ObjectId;
  createdAt: Date;
  updatedAt: Date;
}

const OrganizationInviteSchema = new Schema<IOrganizationInvite>({
  organizationId: {
    type: Schema.Types.ObjectId,
    ref: 'Organization',
    required: true,
  },
  email: {
    type: String,
    lowercase: true,
    trim: true,
  },
  role: {
    type: String,
    enum: ['admin', 'member'],
    default: 'member',
  },
  token: {
    type: String,
    required: true,
    unique: true,
  },
  invitedBy: {
    type: Schema.Types.ObjectId,
    ref: 'User',
    required: true,
  },
  status: {
    type: String,
    enum: ['pending', 'accepted', 'declined', 'expired'],
    default: 'pending',
  },
  expiresAt: {
    type: Date,
    required: true,
  },
  acceptedAt: {
    type: Date,
  },
  acceptedBy: {
    type: Schema.Types.ObjectId,
    ref: 'User',
  },
}, {
  timestamps: true,
});

// Indexes
OrganizationInviteSchema.index({ organizationId: 1, email: 1 }, { sparse: true });
OrganizationInviteSchema.index({ token: 1 }, { unique: true });
OrganizationInviteSchema.index({ email: 1, status: 1 }, { sparse: true });
// TTL: auto-delete expired invites after 30 days past their expiry
OrganizationInviteSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 30 * 24 * 60 * 60 });

export const OrganizationInvite: Model<IOrganizationInvite> = mongoose.models.OrganizationInvite || mongoose.model<IOrganizationInvite>('OrganizationInvite', OrganizationInviteSchema);
