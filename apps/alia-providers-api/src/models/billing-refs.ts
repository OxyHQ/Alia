/**
 * Billing Reference Models
 *
 * Minimal schemas for billing-related collections that live in the main API's database.
 * These are read-only references used by admin routes for viewing transactions,
 * subscriptions, and user credit summaries.
 *
 * NOTE: These models connect to the MAIN API's database, not the providers database.
 * Set MAIN_DB_URI if different from MONGODB_URI.
 */

import mongoose, { Schema, Document, Model } from 'mongoose';

// Use a secondary connection to the main API's database
const mainDbName = `alia-${process.env.NODE_ENV || 'development'}`;
let mainConn: mongoose.Connection | null = null;

function getMainConnection(): mongoose.Connection {
  if (!mainConn) {
    const uri = process.env.MONGODB_URI;
    if (!uri) throw new Error('MONGODB_URI required for billing refs');
    mainConn = mongoose.createConnection(uri, { dbName: mainDbName });
  }
  return mainConn;
}

// --- Transaction ---

export interface ITransaction extends Document {
  oxyUserId: string;
  type: string;
  amount: number;
  credits: number;
  status: string;
  createdAt: Date;
}

const TransactionSchema = new Schema<ITransaction>({
  oxyUserId: String,
  type: String,
  amount: Number,
  credits: Number,
  status: String,
}, { timestamps: true, strict: false });

export const Transaction = getMainConnection().model<ITransaction>('Transaction', TransactionSchema);

// --- Subscription ---

export interface ISubscription extends Document {
  oxyUserId: string;
  planId: string;
  status: string;
  startDate: Date;
  endDate: Date;
  createdAt: Date;
}

const SubscriptionSchema = new Schema<ISubscription>({
  oxyUserId: String,
  planId: String,
  status: String,
  startDate: Date,
  endDate: Date,
}, { timestamps: true, strict: false });

export const Subscription = getMainConnection().model<ISubscription>('Subscription', SubscriptionSchema);

// --- UserCredits ---

export interface IUserCredits extends Document {
  oxyUserId: string;
  balance: number;
  totalEarned: number;
  totalSpent: number;
}

const UserCreditsSchema = new Schema<IUserCredits>({
  oxyUserId: String,
  balance: Number,
  totalEarned: Number,
  totalSpent: Number,
}, { timestamps: true, strict: false });

export const UserCredits = getMainConnection().model<IUserCredits>('UserCredits', UserCreditsSchema);

// --- ApiKeyUsage ---

export interface IApiKeyUsage extends Document {
  keyId: string;
  provider: string;
  modelId: string;
  requestCount: number;
  totalTokens: number;
  date: Date;
}

const ApiKeyUsageSchema = new Schema<IApiKeyUsage>({
  keyId: String,
  provider: String,
  modelId: String,
  requestCount: Number,
  totalTokens: Number,
  date: Date,
}, { timestamps: true, strict: false });

const ApiKeyUsage = getMainConnection().model<IApiKeyUsage>('ApiKeyUsage', ApiKeyUsageSchema);
export default ApiKeyUsage;
