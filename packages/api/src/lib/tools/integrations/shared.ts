/**
 * Shared utilities for integration tools — validators, safe execution,
 * authenticated fetch helpers.
 */

import mongoose from 'mongoose';
import { Integration } from '../../../models/integration.js';
import { getValidToken } from '../../integration-token.js';
import { log } from '../../logger.js';
import { getErrorMessage } from '../../errors/index.js';

export const TOOL_TIMEOUT_MS = 15_000;

// ---------------------------------------------------------------------------
// Input validators — prevent path traversal, injection via AI-controlled params
// ---------------------------------------------------------------------------

/** GitHub "owner/repo" — alphanumeric, hyphens, underscores, dots, one slash */
export const GITHUB_REPO_RE = /^[a-zA-Z0-9._-]+\/[a-zA-Z0-9._-]+$/;

/** GitHub branch names — alphanumeric, dots, hyphens, underscores, slashes */
export const GITHUB_BRANCH_RE = /^[a-zA-Z0-9._/-]+$/;

/** Notion/Linear IDs — UUID v4 with or without dashes */
export const UUID_RE = /^[0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12}$/i;

/** Google Drive file IDs — alphanumeric, hyphens, underscores */
export const DRIVE_FILE_ID_RE = /^[a-zA-Z0-9_-]+$/;

/**
 * Normalize a GitHub repo identifier. Accepts both:
 *   - "owner/repo" (pass-through)
 *   - Full GitHub URLs like "https://github.com/owner/repo/tree/main/..."
 * Returns the "owner/repo" portion.
 */
export function normalizeGitHubRepo(input: string): string {
  if (GITHUB_REPO_RE.test(input)) return input;

  try {
    const url = new URL(input);
    if (url.hostname === 'github.com' || url.hostname === 'www.github.com') {
      const parts = url.pathname.split('/').filter(Boolean);
      if (parts.length >= 2) {
        return `${parts[0]}/${parts[1]}`;
      }
    }
  } catch {
    // Not a valid URL — fall through
  }

  return input;
}

export function assertGitHubRepo(repo: string): void {
  if (!GITHUB_REPO_RE.test(repo)) {
    throw new Error('Invalid repository format — expected "owner/repo"');
  }
}

export function assertGitHubBranch(branch: string): void {
  if (!GITHUB_BRANCH_RE.test(branch) || branch.includes('..')) {
    throw new Error('Invalid branch name');
  }
}

export function assertGitHubPath(path: string): void {
  if (path.includes('\0') || path.includes('..')) {
    throw new Error('Invalid file path — traversal not allowed');
  }
}

export function assertUUID(id: string, label: string): void {
  if (!UUID_RE.test(id)) {
    throw new Error(`Invalid ${label} — expected a UUID`);
  }
}

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
  Integration.updateOne(
    { oxyUserId: new mongoose.Types.ObjectId(userId), service, enabled: true },
    { lastUsedAt: new Date() },
  ).catch((err) => log.general.warn({ err, service }, 'Failed to update integration lastUsedAt'));

  return response.json();
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

  Integration.updateOne(
    { oxyUserId: new mongoose.Types.ObjectId(userId), service, enabled: true },
    { lastUsedAt: new Date() },
  ).catch((err) => log.general.warn({ err, service }, 'Failed to update integration lastUsedAt'));

  return response.text();
}
