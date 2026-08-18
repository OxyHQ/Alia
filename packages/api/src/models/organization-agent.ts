import mongoose, { Schema, Model, Document } from 'mongoose';

export interface IOrganizationAgent extends Document {
  organizationId: mongoose.Types.ObjectId;
  agentId: mongoose.Types.ObjectId;
  addedBy: mongoose.Types.ObjectId;
  createdAt: Date;
}

const OrganizationAgentSchema = new Schema<IOrganizationAgent>({
  /**
   * `ref: 'Organization'` was removed when S9 deleted `models/organization.ts`.
   *
   * The declaration was already inert — nothing populated it, and
   * `db/schema/organizations.ts` records why — but a `ref` naming a model this
   * service no longer registers is not merely unused: `.populate('organizationId')`
   * would answer `MissingSchemaError`, and only once there is a document to
   * populate, which is the exact shape of the fault
   * `models/__tests__/foreign-ref-populate.test.ts` exists to stop. That gate is
   * what caught this. The column is unchanged.
   */
  organizationId: { type: Schema.Types.ObjectId, required: true, index: true },
  agentId: { type: Schema.Types.ObjectId, ref: 'Agent', required: true },
  addedBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
}, { timestamps: true });

OrganizationAgentSchema.index({ organizationId: 1, agentId: 1 }, { unique: true });

export const OrganizationAgent: Model<IOrganizationAgent> = mongoose.models.OrganizationAgent || mongoose.model<IOrganizationAgent>('OrganizationAgent', OrganizationAgentSchema);
