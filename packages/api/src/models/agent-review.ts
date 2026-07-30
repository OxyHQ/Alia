import mongoose, { Schema, Model, Document } from 'mongoose';

export interface IAgentReview extends Document {
  agentId: mongoose.Types.ObjectId;
  userId: mongoose.Types.ObjectId;
  rating: number;
  comment: string;
  /**
   * Withheld from the public listing and from the agent's rating by a moderation
   * decision.
   *
   * A separate field rather than a delete, because every moderation effect has to
   * be reversible: an appeal that succeeds must be able to put the review back,
   * and a row that was deleted cannot be. It is also why the rating aggregate
   * excludes hidden reviews — a review withheld for being abusive or fake should
   * not keep moving the number it was filed to move.
   */
  hiddenByModeration: boolean;
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
  hiddenByModeration: {
    type: Boolean,
    default: false,
  },
}, {
  timestamps: true,
});

// One review per user per agent
AgentReviewSchema.index({ agentId: 1, userId: 1 }, { unique: true });
AgentReviewSchema.index({ agentId: 1, createdAt: -1 });

export const AgentReview: Model<IAgentReview> =
  mongoose.models.AgentReview || mongoose.model<IAgentReview>('AgentReview', AgentReviewSchema);
