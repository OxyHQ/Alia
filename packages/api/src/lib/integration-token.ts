/**
 * Integration Token Manager
 *
 * Provides getValidToken() to retrieve a fresh OAuth access token for a
 * user's connected integration, automatically refreshing when expired.
 *
 * Uses in-flight deduplication to prevent concurrent refresh races
 * (e.g. Google rotates refresh tokens on first use — a double-refresh
 * would permanently invalidate the integration).
 *
 * ## This is the only module that handles integration tokens in the clear
 *
 * `findEnabledIntegrationTokens` is the single reader that projects
 * `oauth_access_token` / `oauth_refresh_token`; every other read of this table
 * goes through a projection that has no token column at all. The plaintext
 * exists here because a token cannot be sent to a provider otherwise, and it
 * exists nowhere else — in particular it is never logged, and the failure paths
 * below log the provider's `error` fields rather than its reply.
 */

import { getDb } from '../db/index.js';
import {
  findEnabledIntegrationTokens,
  saveRefreshedIntegrationTokens,
  setIntegrationStatus,
  type IntegrationTokenRow,
} from '../db/integrations/integrationRepository.js';
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
  const db = getDb();
  const integration = await findEnabledIntegrationTokens(db, userId, service);

  if (!integration) {
    throw new Error(`No active ${service} integration found`);
  }

  if (integration.status === 'revoked') {
    throw new Error(`${service} integration has been revoked — please reconnect`);
  }

  // If no expiry is set (e.g. GitHub) the token is long-lived — return as-is
  if (!integration.expiresAt) {
    return integration.accessToken;
  }

  const expiresAt = integration.expiresAt.getTime();
  if (Date.now() < expiresAt - TOKEN_EXPIRY_BUFFER_MS) {
    // Token is still valid
    return integration.accessToken;
  }

  // Token is expired or about to expire — attempt refresh
  if (!integration.refreshToken) {
    await setIntegrationStatus(db, integration.id, 'expired');
    throw new Error(`${service} token expired and no refresh token available — please reconnect`);
  }

  // Deduplicate: if a refresh is already in-flight for this integration, await it
  const existing = inflightRefreshes.get(integration.id);
  if (existing) {
    return existing;
  }

  const promise = refreshAndPersist(integration).finally(() => {
    inflightRefreshes.delete(integration.id);
  });
  inflightRefreshes.set(integration.id, promise);
  return promise;
}

/**
 * Exchange the refresh token and store the result.
 *
 * Takes the row rather than a hydrated document, so the narrowing that
 * `getValidToken` already did — `refreshToken` is present — has to be re-stated
 * here rather than assumed. It is, as a throw: the alternative is a
 * `refresh_token: null` sent to the provider, which fails with the provider's
 * wording instead of ours.
 */
async function refreshAndPersist(integration: IntegrationTokenRow): Promise<string> {
  const db = getDb();
  const entry = INTEGRATION_REGISTRY.find(e => e.service === integration.service);
  if (!entry) {
    throw new Error(`Unknown service: ${integration.service}`);
  }
  if (!integration.refreshToken) {
    throw new Error(`${integration.service} has no refresh token — please reconnect`);
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
    refresh_token: integration.refreshToken,
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
      await setIntegrationStatus(db, integration.id, 'expired');
      throw new Error(`Failed to refresh ${integration.service} token — please reconnect`);
    }

    // `encryptedText`'s `toDriver` encrypts on the way to the server, so there is
    // no spelling of this write through the query builder that stores the token
    // in the clear. The Mongoose equivalent was a `set: encrypt` field setter,
    // and the source had to reach for `document.save()` specifically because a
    // dotted-path `updateOne()` bypassed it. That hazard is gone: the codec is on
    // the COLUMN, so every write goes through it however it is spelled.
    //
    // `refreshToken` and `expiresAt` are passed only when the reply carried
    // them, matching the source's `if (data.refresh_token)` — a provider that
    // rotates only the access token must not have its long-lived refresh token
    // erased.
    await saveRefreshedIntegrationTokens(db, integration.id, {
      accessToken: data.access_token,
      refreshToken: data.refresh_token || undefined,
      expiresAt: data.expires_in ? new Date(Date.now() + data.expires_in * 1000) : undefined,
    });

    log.general.info({ service: integration.service }, 'Token refreshed successfully');
    return data.access_token;
  } catch (err: unknown) {
    const errMsg = getErrorMessage(err);
    if (errMsg.includes('please reconnect')) throw err;
    log.general.error({ err, service: integration.service }, 'Token refresh error');
    await setIntegrationStatus(db, integration.id, 'error');
    throw new Error(`Error refreshing ${integration.service} token: ${errMsg}`, { cause: err });
  }
}
