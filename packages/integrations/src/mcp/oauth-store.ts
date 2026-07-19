/**
 * MCP Connector OAuth Store
 *
 * Per-(user, server) persistence backing the `AliaOAuthProvider`
 * `OAuthClientProvider` implementation. Holds the three artifacts the MCP SDK
 * OAuth lifecycle needs — the Dynamic Client Registration client info, the
 * issued OAuth tokens, and the in-flight PKCE code verifier — plus the
 * interactive authorization URL captured during the redirect step.
 *
 * All secret artifacts are stored as AES-256-GCM ciphertext (encrypted by the
 * provider before write via `../shared/crypto`), so tokens are never at rest in
 * plaintext. The schema keeps plain string columns; encryption/serialization is
 * centralized in the provider.
 */

import mongoose, { Schema, Document } from 'mongoose';

export interface IMcpConnectorAuth extends Document {
  oxyUserId: string;
  serverId: string;
  /** Encrypted JSON of the DCR client information. */
  clientInformation?: string;
  /** Encrypted JSON of the issued OAuthTokens. */
  tokens?: string;
  /** Encrypted PKCE code verifier for the in-flight authorization. */
  codeVerifier?: string;
  /** Last interactive authorization URL captured during redirect (not a secret). */
  authorizationUrl?: string;
  createdAt: Date;
  updatedAt: Date;
}

const McpConnectorAuthSchema = new Schema<IMcpConnectorAuth>(
  {
    oxyUserId: {
      type: String,
      required: true,
      index: true,
    },
    serverId: {
      type: String,
      required: true,
      index: true,
    },
    clientInformation: {
      type: String,
    },
    tokens: {
      type: String,
    },
    codeVerifier: {
      type: String,
    },
    authorizationUrl: {
      type: String,
    },
  },
  {
    timestamps: true,
  },
);

McpConnectorAuthSchema.index({ oxyUserId: 1, serverId: 1 }, { unique: true });

export const McpConnectorAuth = mongoose.model<IMcpConnectorAuth>(
  'McpConnectorAuth',
  McpConnectorAuthSchema,
);

/**
 * Load (or atomically create) the auth record for a (user, server) pair.
 * Uses an upsert so concurrent OAuth callbacks never collide on the unique
 * compound index.
 */
export async function getOrCreateConnectorAuth(
  oxyUserId: string,
  serverId: string,
): Promise<IMcpConnectorAuth> {
  const doc = await McpConnectorAuth.findOneAndUpdate(
    { oxyUserId, serverId },
    { $setOnInsert: { oxyUserId, serverId } },
    { upsert: true, new: true },
  );
  if (!doc) {
    throw new Error('Failed to load MCP connector auth record');
  }
  return doc;
}
