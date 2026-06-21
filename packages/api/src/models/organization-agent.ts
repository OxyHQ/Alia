import mongoose, { Schema, Model, Document } from 'mongoose';

export interface IOrganizationAgent extends Document {
  organizationId: mongoose.Types.ObjectId;
  agentId: mongoose.Types.ObjectId;
  addedBy: mongoose.Types.ObjectId;
  createdAt: Date;
}

const OrganizationAgentSchema = new Schema<IOrganizationAgent>({
  organizationId: { type: Schema.Types.ObjectId, ref: 'Organization', required: true, index: true },
  agentId: { type: Schema.Types.ObjectId, ref: 'Agent', required: true },
  addedBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
}, { timestamps: true });

OrganizationAgentSchema.index({ organizationId: 1, agentId: 1 }, { unique: true });

export const OrganizationAgent: Model<IOrganizationAgent> = mongoose.models.OrganizationAgent || mongoose.model<IOrganizationAgent>('OrganizationAgent', OrganizationAgentSchema);
