/**
 * Integration Token Manager
 *
 * Provides getValidToken() to retrieve a fresh OAuth access token for a
 * user's connected integration, automatically refreshing when expired.
 *
 * Uses in-flight deduplication to prevent concurrent refresh races
 * (e.g. Google rotates refresh tokens on first use — a double-refresh
 * would permanently invalidate the integration).
 */

import mongoose from 'mongoose';
import { Integration, type IIntegration } from '../models/integration.js';
import { INTEGRATION_REGISTRY } from './integration-registry.js';
import { log } from './logger.js';
import { getErrorMessage } from './errors/index.js';

const TOKEN_EXPIRY_BUFFER_MS = 5 * 60 * 1000; // refresh 5 minutes before expiry

// In-flight refresh deduplication: key = integrationId, value = pending promise.
// Prevents concurrent requests from triggering parallel refreshes that could
// invalidate each other (especially for providers that rotate refresh tokens).
const inflightRefreshes = new Map<string, Promise<string>>();

/**
 * Get a valid access token for the given user + service.
 * If the token is expired (or within the buffer window) and a refresh token
 * exists, it will be automatically refreshed and persisted.
 *
 * @returns The access token string
 * @throws If the integration is not found, disabled, or the token cannot be refreshed
 */
export async function getValidToken(userId: string, service: string): Promise<string> {
  const integration = await Integration.findOne({
    oxyUserId: new mongoose.Types.ObjectId(userId),
    service,
    enabled: true,
  });

  if (!integration) {
    throw new Error(`No active ${service} integration found`);
  }

  if (integration.status === 'revoked') {
    throw new Error(`${service} integration has been revoked — please reconnect`);
  }

  const { oauthTokens } = integration;

  // If no expiry is set (e.g. GitHub) the token is long-lived — return as-is
  if (!oauthTokens.expiresAt) {
    return oauthTokens.accessToken;
  }

  const expiresAt = new Date(oauthTokens.expiresAt).getTime();
  if (Date.now() < expiresAt - TOKEN_EXPIRY_BUFFER_MS) {
    // Token is still valid
    return oauthTokens.accessToken;
  }

  // Token is expired or about to expire — attempt refresh
  if (!oauthTokens.refreshToken) {
    await Integration.updateOne({ _id: integration._id }, { status: 'expired' });
    throw new Error(`${service} token expired and no refresh token available — please reconnect`);
  }

  // Deduplicate: if a refresh is already in-flight for this integration, await it
  const integrationId = integration._id.toString();
  const existing = inflightRefreshes.get(integrationId);
  if (existing) {
    return existing;
  }

  const promise = refreshAndPersist(integration).finally(() => {
    inflightRefreshes.delete(integrationId);
  });
  inflightRefreshes.set(integrationId, promise);
  return promise;
}

async function refreshAndPersist(integration: IIntegration): Promise<string> {
  const entry = INTEGRATION_REGISTRY.find(e => e.service === integration.service);
  if (!entry) {
    throw new Error(`Unknown service: ${integration.service}`);
  }

  const clientId = process.env[entry.oauthConfig.envClientId];
  const clientSecret = process.env[entry.oauthConfig.envClientSecret];
  if (!clientId || !clientSecret) {
    throw new Error(`${integration.service} OAuth credentials not configured`);
  }

  const authMethod = entry.oauthConfig.authMethod || 'body';
  const headers: Record<string, string> = {
    'Content-Type': 'application/x-www-form-urlencoded',
    Accept: 'application/json',
  };
  const bodyParams: Record<string, string> = {
    grant_type: 'refresh_token',
    refresh_token: integration.oauthTokens.refreshToken!,
  };

  if (authMethod === 'basic') {
    headers['Authorization'] = `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString('base64')}`;
  } else {
    bodyParams.client_id = clientId;
    bodyParams.client_secret = clientSecret;
  }

  try {
    const response = await fetch(entry.oauthConfig.tokenUrl, {
      method: 'POST',
      headers,
      body: new URLSearchParams(bodyParams),
      signal: AbortSignal.timeout(10_000),
    });

    const data = await response.json();

    if (!response.ok || !data.access_token) {
      // Log only error fields — never log token values
      log.general.error(
        { error: data.error, errorDescription: data.error_description, service: integration.service },
        'Token refresh failed',
      );
      await Integration.updateOne({ _id: integration._id }, { status: 'expired' });
      throw new Error(`Failed to refresh ${integration.service} token — please reconnect`);
    }

    // Persist via document assignment + save() so the schema's `set: encrypt`
    // setters run — a dotted-path updateOne() bypasses setters (verified on
    // mongoose 9), which would store the refreshed token in PLAINTEXT and then
    // break the read-path `get: decrypt` getter on the next access.
    integration.oauthTokens.accessToken = data.access_token;
    if (data.refresh_token) {
      integration.oauthTokens.refreshToken = data.refresh_token;
    }
    if (data.expires_in) {
      integration.oauthTokens.expiresAt = new Date(Date.now() + data.expires_in * 1000);
    }
    integration.status = 'active';
    await integration.save();

    log.general.info({ service: integration.service }, 'Token refreshed successfully');
    return data.access_token;
  } catch (err: unknown) {
    const errMsg = getErrorMessage(err);
    if (errMsg.includes('please reconnect')) throw err;
    log.general.error({ err, service: integration.service }, 'Token refresh error');
    await Integration.updateOne({ _id: integration._id }, { status: 'error' });
    throw new Error(`Error refreshing ${integration.service} token: ${errMsg}`, { cause: err });
  }
}
