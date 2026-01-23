import mongoose, { Schema, Model, Document } from 'mongoose';

export interface IWorkflowNode {
  id: string;
  type: string;
  position: { x: number; y: number };
  data: Record<string, any>;
}

export interface IWorkflowEdge {
  id: string;
  source: string;
  target: string;
  type?: string;
  animated?: boolean;
}

export interface IWorkflow extends Document {
  oxyUserId: mongoose.Types.ObjectId;
  workflowId: string;
  name: string;
  description?: string;
  nodes: IWorkflowNode[];
  edges: IWorkflowEdge[];
  createdAt: Date;
  updatedAt: Date;
}

const WorkflowNodeSchema = new Schema({
  id: { type: String, required: true },
  type: { type: String, required: true },
  position: {
    x: { type: Number, required: true },
    y: { type: Number, required: true }
  },
  data: { type: Schema.Types.Mixed, required: true }
}, { _id: false });

const WorkflowEdgeSchema = new Schema({
  id: { type: String, required: true },
  source: { type: String, required: true },
  target: { type: String, required: true },
  type: { type: String },
  animated: { type: Boolean }
}, { _id: false });

const WorkflowSchema = new Schema<IWorkflow>({
  oxyUserId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  workflowId: { type: String, required: true, unique: true, index: true },
  name: { type: String, required: true },
  description: { type: String },
  nodes: [WorkflowNodeSchema],
  edges: [WorkflowEdgeSchema],
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now }
});

// Update the updatedAt field on save
WorkflowSchema.pre('save', function(next) {
  this.updatedAt = new Date();
  next();
});

export const Workflow: Model<IWorkflow> = mongoose.models.Workflow || mongoose.model<IWorkflow>('Workflow', WorkflowSchema);
