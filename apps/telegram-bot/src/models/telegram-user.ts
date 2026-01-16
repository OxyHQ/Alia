import mongoose, { Document, Schema } from 'mongoose';

export interface ITelegramUser extends Document {
  telegramId: string;
  userId: mongoose.Types.ObjectId;
  chatId: string;
  username?: string;
  firstName?: string;
  lastName?: string;
  authToken?: string; // Temporary token for authentication
  authTokenExpiry?: Date;
  sessionToken?: string; // JWT token from API
  conversationId?: string; // Current active conversation
  isAuthenticated: boolean;
  linkedAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

const TelegramUserSchema = new Schema<ITelegramUser>(
  {
    telegramId: {
      type: String,
      required: true,
      unique: true,
      index: true,
    },
    userId: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      sparse: true, // Allow null for unauthenticated users
    },
    chatId: {
      type: String,
      required: true,
    },
    username: String,
    firstName: String,
    lastName: String,
    authToken: String,
    authTokenExpiry: Date,
    sessionToken: String,
    conversationId: String,
    isAuthenticated: {
      type: Boolean,
      default: false,
    },
    linkedAt: Date,
  },
  {
    timestamps: true,
  }
);

// Clean up expired auth tokens
TelegramUserSchema.methods.isAuthTokenValid = function (): boolean {
  if (!this.authToken || !this.authTokenExpiry) {
    return false;
  }
  return this.authTokenExpiry > new Date();
};

export const TelegramUser = mongoose.model<ITelegramUser>(
  'TelegramUser',
  TelegramUserSchema
);
