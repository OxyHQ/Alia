import mongoose, { Schema, Model, Document } from 'mongoose';

export interface IAutomationSchedule {
  type: 'daily' | 'interval';
  time?: string;        // e.g. "18:00"
  days?: string[];      // e.g. ['monday', 'tuesday']
  intervalMinutes?: number; // for interval type
}

export interface IAutomation extends Document {
  oxyUserId: mongoose.Types.ObjectId;
  name: string;
  prompt: string;
  roleId?: string;
  schedule: IAutomationSchedule;
  enabled: boolean;
  lastRunAt?: Date;
  nextRunAt?: Date;
  runCount: number;
  lastRunResult?: string;
  lastRunStatus?: 'success' | 'failed' | 'running';
  createdAt: Date;
  updatedAt: Date;
}

const AutomationScheduleSchema = new Schema<IAutomationSchedule>({
  type: {
    type: String,
    required: true,
    enum: ['daily', 'interval'],
  },
  time: { type: String },
  days: [{ type: String }],
  intervalMinutes: { type: Number },
}, { _id: false });

const AutomationSchema = new Schema<IAutomation>({
  oxyUserId: {
    type: Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    index: true,
  },
  name: { type: String, required: true },
  prompt: { type: String, required: true },
  roleId: { type: String },
  schedule: { type: AutomationScheduleSchema, required: true },
  enabled: { type: Boolean, default: true },
  lastRunAt: { type: Date },
  nextRunAt: { type: Date },
  runCount: { type: Number, default: 0 },
  lastRunResult: { type: String },
  lastRunStatus: {
    type: String,
    enum: ['success', 'failed', 'running'],
  },
}, {
  timestamps: true,
});

// Evitar recompilación del modelo en hot-reload
export const Automation: Model<IAutomation> = mongoose.models.Automation || mongoose.model<IAutomation>('Automation', AutomationSchema);
