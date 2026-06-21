import mongoose, { Schema, Model, Document } from 'mongoose';
import type { IMessage, IToolInvocation, IAgentInfo } from './conversation.js';

export interface IMessageDocument extends IMessage, Document {
  conversationId: string;
  oxyUserId: mongoose.Types.ObjectId;
}

const ToolInvocationSchema = new Schema<IToolInvocation>({
  toolCallId: String,
  toolName: String,
  state: {
    type: String,
    enum: ['partial-call', 'call', 'result'],
  },
  args: Schema.Types.Mixed,
  result: Schema.Types.Mixed,
}, { _id: false });

const AgentInfoSchema = new Schema<IAgentInfo>({
  id: String,
  name: String,
  avatar: { type: String, default: null },
  handle: String,
}, { _id: false });

const MessageSchema = new Schema<IMessageDocument>({
  conversationId: { type: String, required: true },
  oxyUserId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  id: String,
  role: { type: String, required: true, enum: ['user', 'assistant', 'system'] },
  content: { type: Schema.Types.Mixed, required: true },
  vote: { type: String, enum: ['up', 'down'], required: false },
  toolInvocations: [ToolInvocationSchema],
  agentInfo: { type: AgentInfoSchema, required: false },
  audioUrl: { type: String, required: false },
  createdAt: { type: Date, default: Date.now },
});

// Fast lookups: all messages for a conversation, ordered by creation time
MessageSchema.index({ conversationId: 1, createdAt: 1 });
// Cascade deletes: find all messages for a user's conversation
MessageSchema.index({ oxyUserId: 1, conversationId: 1 });

export const Message: Model<IMessageDocument> =
  mongoose.models.Message || mongoose.model<IMessageDocument>('Message', MessageSchema);
