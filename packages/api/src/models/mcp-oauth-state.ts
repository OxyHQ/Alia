import mongoose, { Schema, Document } from 'mongoose';

/**
 * Short-lived, single-use OAuth `state` for the interactive MCP connector
 * flow. Mirrors the atomic-consume + TTL pattern used by the integrations
 * OAuth state store: a random `state` is minted when the authorize is kicked
 * off, and the public callback consumes it via `findOneAndDelete` to recover
 * the originating (user, server) — preventing replay. The TTL index expires
 * abandoned rows automatically.
 */

export const MCP_OAUTH_STATE_TTL_SECONDS = 10 * 60; // 10 minutes

export interface IMcpOAuthState extends Document {
  state: string;
  oxyUserId: string;
  serverId: string;
  createdAt: Date;
}

const McpOAuthStateSchema = new Schema<IMcpOAuthState>({
  state: { type: String, required: true, unique: true },
  oxyUserId: { type: String, required: true },
  serverId: { type: String, required: true },
  createdAt: { type: Date, default: Date.now },
});

// TTL auto-cleanup — abandoned states are removed ~10 minutes after creation.
McpOAuthStateSchema.index({ createdAt: 1 }, { expireAfterSeconds: MCP_OAUTH_STATE_TTL_SECONDS });

export const McpOAuthState = mongoose.model<IMcpOAuthState>('McpOAuthState', McpOAuthStateSchema);
