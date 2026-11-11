/**
 * Shared utilities for integration tools — validators, safe execution,
 * authenticated fetch helpers.
 */

import { getDb } from '../../../db/index.js';
import { touchIntegrationLastUsed } from '../../../db/integrations/integrationRepository.js';
import { getValidToken } from '../../integration-token.js';
import { log } from '../../logger.js';
import { getErrorMessage } from '../../errors/index.js';

export const TOOL_TIMEOUT_MS = 15_000;

// ---------------------------------------------------------------------------
// Input validators — prevent path traversal, injection via AI-controlled params
// ---------------------------------------------------------------------------

/** Google Drive file IDs — alphanumeric, hyphens, underscores */
const DRIVE_FILE_ID_RE = /^[a-zA-Z0-9_-]+$/;

export function assertDriveFileId(id: string): void {
  if (!DRIVE_FILE_ID_RE.test(id)) {
    throw new Error('Invalid Drive file ID');
  }
}

// ---------------------------------------------------------------------------
// Safe execution wrapper — tools never throw, always return structured data
// ---------------------------------------------------------------------------

export async function safeExecute(service: string, fn: () => Promise<any>): Promise<any> {
  try {
    return await fn();
  } catch (err: unknown) {
    log.general.warn({ err, service }, 'Integration tool error');
    return { error: `Could not access ${service}: ${getErrorMessage(err).slice(0, 150)}` };
  }
}

// ---------------------------------------------------------------------------
// Authenticated fetch helpers
// ---------------------------------------------------------------------------

export async function authedFetch(
  userId: string,
  service: string,
  url: string,
  options: RequestInit = {},
): Promise<any> {
  const token = await getValidToken(userId, service);
  const response = await fetch(url, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/json',
      ...(options.headers || {}),
    },
    signal: AbortSignal.timeout(TOOL_TIMEOUT_MS),
  });

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(`${service} API error (${response.status}): ${body.slice(0, 200)}`);
  }

  // Update lastUsedAt in background
  touchIntegrationLastUsed(getDb(), userId, service).catch((err) =>
    log.general.warn({ err, service }, 'Failed to update integration lastUsedAt'),
  );

  // An action the provider accepted with no body (Graph's 202 for sendMail, a
  // 204) is a success with nothing to read, not a JSON error.
  const body = await response.text();
  return body ? JSON.parse(body) : {};
}

/**
 * Authenticated download, for a file read as bytes and turned into text here.
 * Refuses a body over `maxBytes` before reading it whole when the provider says
 * its length, and after otherwise.
 */
export async function authedFetchBytes(
  userId: string,
  service: string,
  url: string,
  maxBytes: number,
): Promise<{ bytes: Uint8Array; contentType: string }> {
  const token = await getValidToken(userId, service);
  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(TOOL_TIMEOUT_MS * 2),
  });

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(`${service} API error (${response.status}): ${body.slice(0, 200)}`);
  }
  const declared = Number(response.headers.get('content-length') ?? '0');
  if (declared > maxBytes) throw new Error('The file is too large to read here');
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength > maxBytes) throw new Error('The file is too large to read here');

  touchIntegrationLastUsed(getDb(), userId, service).catch((err) =>
    log.general.warn({ err, service }, 'Failed to update integration lastUsedAt'),
  );

  return { bytes, contentType: response.headers.get('content-type') ?? '' };
}

/** Authenticated fetch that returns raw text instead of JSON */
export async function authedFetchText(
  userId: string,
  service: string,
  url: string,
  options: RequestInit = {},
): Promise<string> {
  const token = await getValidToken(userId, service);
  const response = await fetch(url, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(options.headers || {}),
    },
    signal: AbortSignal.timeout(TOOL_TIMEOUT_MS),
  });

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(`${service} API error (${response.status}): ${body.slice(0, 200)}`);
  }

  touchIntegrationLastUsed(getDb(), userId, service).catch((err) =>
    log.general.warn({ err, service }, 'Failed to update integration lastUsedAt'),
  );

  return response.text();
}
