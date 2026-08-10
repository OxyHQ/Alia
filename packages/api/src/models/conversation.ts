import mongoose, { Schema, Model, Document } from 'mongoose';
import { CONVERSATION_SOURCES, ConversationSource, MessageRole, MessageVote } from '../value-sets/conversation.js';

export const TOOL_INVOCATION_STATES = ['partial-call', 'call', 'result'] as const;
export type ToolInvocationState = (typeof TOOL_INVOCATION_STATES)[number];

export interface IToolInvocation {
  toolCallId: string;
  toolName: string;
  state: ToolInvocationState;
  args?: any;
  result?: any;
}

export interface IAgentInfo {
  id: string;
  name: string;
  avatar: string | null;
  handle: string;
}

export interface IMessage {
  id?: string;
  role: MessageRole;
  content: string | Array<{ type: string; [key: string]: any }>;
  vote?: MessageVote;
  toolInvocations?: IToolInvocation[];
  agentInfo?: IAgentInfo;
  audioUrl?: string;
  createdAt?: Date;
}

export interface IConversation extends Document {
  oxyUserId: mongoose.Types.ObjectId;
  conversationId: string;
  title: string;
  isManualTitle?: boolean;
  lastMessage?: string;

  // Source tracking - which app/platform the conversation came from
  source?: ConversationSource;

  // Folder & Appearance
  folderId?: mongoose.Types.ObjectId;
  icon?: string;
  iconColor?: string;
  isFavorite?: boolean;
  isPublic?: boolean;
  agentId?: mongoose.Types.ObjectId;

  createdAt: Date;
  updatedAt: Date;
}

const ConversationSchema = new Schema<IConversation>({
  oxyUserId: {
    type: Schema.Types.ObjectId,
    ref: 'User',
    required: true,
  },
  conversationId: {
    type: String,
    required: true,
  },
  title: { type: String, required: true, default: 'New chat' },
  isManualTitle: { type: Boolean, default: false },
  lastMessage: String,

  // Source tracking - which app/platform the conversation came from
  source: {
    type: String,
    enum: [...CONVERSATION_SOURCES],
    default: 'app'
  },

  // Folder & Appearance
  folderId: { type: Schema.Types.ObjectId, ref: 'Folder' },
  icon: { type: String },
  iconColor: { type: String },
  isFavorite: { type: Boolean, default: false },
  isPublic: { type: Boolean, default: false },
  agentId: { type: Schema.Types.ObjectId, ref: 'Agent' },
}, {
  timestamps: true
});

// Compound index for userId + conversationId (unique per user)
ConversationSchema.index({ oxyUserId: 1, conversationId: 1 }, { unique: true });
// Covers GET /conversations sorted pagination: find({ oxyUserId }).sort({ updatedAt: -1 })
ConversationSchema.index({ oxyUserId: 1, updatedAt: -1 });
ConversationSchema.index({ oxyUserId: 1, agentId: 1 });

// Evitar recompilación del modelo en hot-reload
export const Conversation: Model<IConversation> = mongoose.models.Conversation || mongoose.model<IConversation>('Conversation', ConversationSchema);
