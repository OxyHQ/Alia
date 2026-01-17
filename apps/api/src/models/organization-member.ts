import mongoose, { Schema, Model, Document } from 'mongoose';

export interface IOrganizationMember extends Document {
  organizationId: mongoose.Types.ObjectId;
  userId: mongoose.Types.ObjectId;
  role: 'owner' | 'admin' | 'member';
  permissions: string[];
  createdAt: Date;
  updatedAt: Date;
}

const OrganizationMemberSchema = new Schema<IOrganizationMember>({
  organizationId: {
    type: Schema.Types.ObjectId,
    ref: 'Organization',
    required: true,
  },
  userId: {
    type: Schema.Types.ObjectId,
    ref: 'User',
    required: true,
  },
  role: {
    type: String,
    enum: ['owner', 'admin', 'member'],
    default: 'member',
  },
  permissions: [{
    type: String,
  }],
}, {
  timestamps: true,
});

// Indexes
OrganizationMemberSchema.index({ organizationId: 1, userId: 1 }, { unique: true });
OrganizationMemberSchema.index({ userId: 1 });

export const OrganizationMember: Model<IOrganizationMember> = mongoose.models.OrganizationMember || mongoose.model<IOrganizationMember>('OrganizationMember', OrganizationMemberSchema);
