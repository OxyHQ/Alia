import mongoose, { Schema, Model, Document } from 'mongoose';

export interface IToolInvocation {
  toolCallId: string;
  toolName: string;
  state: 'partial-call' | 'call' | 'result';
  args?: any;
  result?: any;
}

export interface IMessage {
  id?: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  vote?: 'up' | 'down';
  toolInvocations?: IToolInvocation[];
  createdAt?: Date;
}

export interface IConversation extends Document {
  userId: mongoose.Types.ObjectId;
  conversationId: string;
  title: string;
  isManualTitle?: boolean;
  lastMessage?: string;
  messages: IMessage[];

  // Folder & Appearance
  folderId?: mongoose.Types.ObjectId;
  icon?: string;
  iconColor?: string;
  isFavorite?: boolean;
  isPublic?: boolean;

  createdAt: Date;
  updatedAt: Date;
}

const ToolInvocationSchema = new Schema<IToolInvocation>({
  toolCallId: String,
  toolName: String,
  state: {
    type: String,
    enum: ['partial-call', 'call', 'result']
  },
  args: Schema.Types.Mixed,
  result: Schema.Types.Mixed
}, { _id: false });

const MessageSchema = new Schema<IMessage>({
  id: String,
  role: { type: String, required: true, enum: ['user', 'assistant', 'system'] },
  content: { type: String, required: true },
  vote: { type: String, enum: ['up', 'down'], required: false },
  toolInvocations: [ToolInvocationSchema],
  createdAt: { type: Date, default: Date.now }
}, { _id: false });

const ConversationSchema = new Schema<IConversation>({
  userId: {
    type: Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    index: true
  },
  conversationId: {
    type: String,
    required: true,
    index: true
  },
  title: { type: String, required: true, default: 'Nueva Conversación' },
  isManualTitle: { type: Boolean, default: false },
  lastMessage: String,
  messages: [MessageSchema],

  // Folder & Appearance
  folderId: { type: Schema.Types.ObjectId, ref: 'Folder' },
  icon: { type: String },
  iconColor: { type: String },
  isFavorite: { type: Boolean, default: false },
  isPublic: { type: Boolean, default: false },
}, {
  timestamps: true
});

// Compound index for userId + conversationId (unique per user)
ConversationSchema.index({ userId: 1, conversationId: 1 }, { unique: true });

// Evitar recompilación del modelo en hot-reload
export const Conversation: Model<IConversation> = mongoose.models.Conversation || mongoose.model<IConversation>('Conversation', ConversationSchema);
