import mongoose, { Schema, Model, Document } from 'mongoose';

export interface IAgentTeam extends Document {
  name: string;
  description?: string;
  creator: mongoose.Types.ObjectId;
  agents: mongoose.Types.ObjectId[];
  createdAt: Date;
  updatedAt: Date;
}

const AgentTeamSchema = new Schema<IAgentTeam>({
  name: { type: String, required: true },
  description: { type: String },
  creator: {
    type: Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    index: true,
  },
  agents: [{
    type: Schema.Types.ObjectId,
    ref: 'Agent',
  }],
}, {
  timestamps: true,
});

AgentTeamSchema.index({ creator: 1, createdAt: -1 });

export const AgentTeam: Model<IAgentTeam> = mongoose.models.AgentTeam || mongoose.model<IAgentTeam>('AgentTeam', AgentTeamSchema);
