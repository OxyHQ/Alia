import mongoose, { Schema, Model, Document } from 'mongoose';

export interface IAgentReview extends Document {
  agentId: mongoose.Types.ObjectId;
  userId: mongoose.Types.ObjectId;
  rating: number;
  comment: string;
  createdAt: Date;
  updatedAt: Date;
}

const AgentReviewSchema = new Schema<IAgentReview>({
  agentId: {
    type: Schema.Types.ObjectId,
    ref: 'Agent',
    required: true,
    index: true,
  },
  userId: {
    type: Schema.Types.ObjectId,
    ref: 'User',
    required: true,
  },
  rating: {
    type: Number,
    required: true,
    min: 1,
    max: 5,
  },
  comment: {
    type: String,
    default: '',
    maxlength: 1000,
  },
}, {
  timestamps: true,
});

// One review per user per agent
AgentReviewSchema.index({ agentId: 1, userId: 1 }, { unique: true });
AgentReviewSchema.index({ agentId: 1, createdAt: -1 });

export const AgentReview: Model<IAgentReview> =
  mongoose.models.AgentReview || mongoose.model<IAgentReview>('AgentReview', AgentReviewSchema);
