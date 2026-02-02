import mongoose from 'mongoose';
import { getAllAliaModels } from '../internal/providers/lib/alia-models.js';

// Telegram User Schema
const TelegramUserSchema = new mongoose.Schema(
  {
    telegramId: {
      type: String,
      required: true,
      unique: true,
      index: true,
    },
    oxyUserId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      sparse: true,
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
    authTokenMode: {
      type: String,
      enum: ['link', 'signin'],
      default: 'link',
    },
    sessionToken: String,
    conversationId: String,
    preferredModel: {
      type: String,
      default: 'alia-lite',
      enum: getAllAliaModels().map(m => m.id),
    },
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

export const TelegramUser = mongoose.model('TelegramUser', TelegramUserSchema);
export type ITelegramUser = mongoose.InferSchemaType<typeof TelegramUserSchema>;
