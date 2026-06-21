import mongoose, { Schema, Model, Document } from 'mongoose';

export interface IContainerTemplate extends Document {
  name: string;
  description?: string;
  baseImage: string;
  snapshotTag: string;
  userId: mongoose.Types.ObjectId;
  agentId?: mongoose.Types.ObjectId;
  createdAt: Date;
  updatedAt: Date;
}

const ContainerTemplateSchema = new Schema<IContainerTemplate>({
  name: { type: String, required: true },
  description: { type: String },
  baseImage: { type: String, required: true },
  snapshotTag: { type: String, required: true, unique: true },
  userId: {
    type: Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    index: true,
  },
  agentId: {
    type: Schema.Types.ObjectId,
    ref: 'Agent',
  },
}, {
  timestamps: true,
});

export const ContainerTemplate: Model<IContainerTemplate> = mongoose.models.ContainerTemplate || mongoose.model<IContainerTemplate>('ContainerTemplate', ContainerTemplateSchema);
