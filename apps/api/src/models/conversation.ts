import mongoose, { Schema, Model, Document } from 'mongoose';

export interface IMessage {
  role: 'user' | 'assistant';
  content: string;
  vote?: 'up' | 'down';
  createdAt: Date;
}

export interface IConversation extends Document {
  title: string;
  isManualTitle?: boolean;
  messages: IMessage[];
  userId?: string; // ID del usuario propietario
  // Folder & Appearance
  folderId?: string;
  icon?: string;
  iconColor?: string;
  isFavorite?: boolean;
  isPublic?: boolean;
  
  createdAt: Date;
  updatedAt: Date;
}

const MessageSchema = new Schema<IMessage>({
  role: { type: String, required: true, enum: ['user', 'assistant'] },
  content: { type: String, required: true },
  vote: { type: String, enum: ['up', 'down'], required: false },
  createdAt: { type: Date, default: Date.now }
});

const ConversationSchema = new Schema<IConversation>({
  title: { type: String, required: true, default: 'Nueva Conversación' },
  isManualTitle: { type: Boolean, default: false },
  messages: [MessageSchema],
  userId: { type: Schema.Types.ObjectId, ref: 'User', required: false },
  
  // New fields
  folderId: { type: Schema.Types.ObjectId, ref: 'Folder' },
  icon: { type: String },
  iconColor: { type: String },
  isFavorite: { type: Boolean, default: false },
  isPublic: { type: Boolean, default: false },
}, {
  timestamps: true
});

// Evitar recompilación del modelo en hot-reload
export const Conversation: Model<IConversation> = mongoose.models.Conversation || mongoose.model<IConversation>('Conversation', ConversationSchema);
