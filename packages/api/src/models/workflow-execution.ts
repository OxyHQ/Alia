import mongoose, { Schema, Model, Document } from 'mongoose';

export interface IWorkflowExecutionResult {
  nodeId: string;
  nodeType: string;
  output: any;
  error?: string;
  timestamp: Date;
}

export interface IWorkflowExecution extends Document {
  oxyUserId: mongoose.Types.ObjectId;
  workflowId: string;
  executionId: string;
  status: 'running' | 'completed' | 'failed';
  results: IWorkflowExecutionResult[];
  finalOutput: string;
  startedAt: Date;
  completedAt?: Date;
}

const WorkflowExecutionResultSchema = new Schema({
  nodeId: { type: String, required: true },
  nodeType: { type: String, required: true },
  output: { type: Schema.Types.Mixed },
  error: { type: String },
  timestamp: { type: Date, default: Date.now }
}, { _id: false });

const WorkflowExecutionSchema = new Schema<IWorkflowExecution>({
  oxyUserId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  workflowId: { type: String, required: true, index: true },
  executionId: { type: String, required: true, unique: true, index: true },
  status: {
    type: String,
    enum: ['running', 'completed', 'failed'],
    required: true,
    default: 'running'
  },
  results: [WorkflowExecutionResultSchema],
  finalOutput: { type: String, default: '' },
  startedAt: { type: Date, default: Date.now },
  completedAt: { type: Date }
});

export const WorkflowExecution: Model<IWorkflowExecution> =
  mongoose.models.WorkflowExecution || mongoose.model<IWorkflowExecution>('WorkflowExecution', WorkflowExecutionSchema);
