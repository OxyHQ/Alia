import mongoose, { Document, Schema } from 'mongoose';

export interface IAdminAudit extends Document {
  timestamp: Date;
  actor: string;
  action: string;
  resource: string;
  resourceId?: string;
  details?: Record<string, unknown>;
  ip?: string;
}

const AdminAuditSchema = new Schema<IAdminAudit>(
  {
    timestamp: { type: Date, default: Date.now, index: true },
    actor: { type: String, required: true, index: true },
    action: { type: String, required: true, index: true },
    resource: { type: String, required: true },
    resourceId: { type: String },
    details: { type: Schema.Types.Mixed },
    ip: { type: String },
  },
  { timestamps: false }
);

// Auto-delete after 90 days
AdminAuditSchema.index({ timestamp: 1 }, { expireAfterSeconds: 90 * 24 * 60 * 60 });

export const AdminAudit =
  mongoose.models.AdminAudit || mongoose.model<IAdminAudit>('AdminAudit', AdminAuditSchema);
