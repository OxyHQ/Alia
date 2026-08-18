/**
 * The MCP connector OAuth store and provider against a real Postgres.
 *
 * The property that matters most here is not "does it round trip" — it is
 * WHERE the encryption happens. Both ways of getting that wrong are silent:
 *
 *  - Encryption dropped from the provider: live OAuth tokens sit in the clear,
 *    and every read still succeeds. Nothing goes red.
 *  - An `encryptedText` codec added to the column while the provider still
 *    encrypts: ciphertext-of-ciphertext. The write succeeds, the row looks
 *    perfectly stored, and every OAuth call fails at the first read.
 *
 * So the assertions below read the RAW column as well as the provider's view:
 * the stored bytes must not contain the plaintext, must match the
 * `iv:authTag:ciphertext` wire format the API process also writes, and must
 * decrypt to the original exactly once.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createCipheriv, randomBytes } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { closePostgres, connectPostgres, type IntegrationsDatabase } from '../../db';
import { mcpConnectorAuths } from '../../db/schema';
import { getOrCreateConnectorAuth, updateConnectorAuth } from '../oauth-store';

/** A 32-byte key as 64 hex chars, which is the only shape `crypto.ts` accepts. */
const TEST_KEY = 'a'.repeat(64);

let db: IntegrationsDatabase;
/** Imported after the key is in the environment; the module reads it lazily. */
let AliaOAuthProvider: typeof import('../oauth-provider').AliaOAuthProvider;
let decrypt: typeof import('../../shared/crypto').decrypt;

/** The `iv:authTag:ciphertext` wire format, with both prefixes fixed length. */
const WIRE_FORMAT = /^[0-9a-f]{24}:[0-9a-f]{32}:[0-9a-f]+$/;

/**
 * A SECOND, independent implementation of the same wire format, standing in for
 * the other process. `packages/api` writes with its own copy of this algorithm
 * under the same `TOKEN_ENCRYPTION_KEY`; if the two ever stop agreeing, tokens
 * written by one become unreadable by the other with no error at write time.
 */
function encryptLikeTheOtherProcess(plaintext: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', Buffer.from(TEST_KEY, 'hex'), iv, {
    authTagLength: 16,
  });
  const body = cipher.update(plaintext, 'utf8', 'hex') + cipher.final('hex');
  return `${iv.toString('hex')}:${cipher.getAuthTag().toString('hex')}:${body}`;
}

/** The row exactly as Postgres holds it, with no provider in the way. */
async function rawRow(oxyUserId: string, serverId: string) {
  const [row] = await db
    .select({
      id: mcpConnectorAuths.id,
      clientInformation: mcpConnectorAuths.clientInformation,
      tokens: mcpConnectorAuths.tokens,
      codeVerifier: mcpConnectorAuths.codeVerifier,
      authorizationUrl: mcpConnectorAuths.authorizationUrl,
    })
    .from(mcpConnectorAuths)
    .where(
      and(eq(mcpConnectorAuths.oxyUserId, oxyUserId), eq(mcpConnectorAuths.serverId, serverId)),
    );
  return row ?? null;
}

function provider(oxyUserId: string, serverId: string) {
  return new AliaOAuthProvider({
    oxyUserId,
    serverId,
    stateToken: 'state-token',
    callbackUrl: 'https://api.alia.onl/mcp/oauth/callback',
  });
}

beforeAll(async () => {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('globalSetup did not publish DATABASE_URL');
  process.env.TOKEN_ENCRYPTION_KEY = TEST_KEY;
  db = connectPostgres(url);
  ({ AliaOAuthProvider } = await import('../oauth-provider'));
  ({ decrypt } = await import('../../shared/crypto'));
});

afterAll(async () => {
  await closePostgres();
});

describe('one row per (user, server), whichever call gets there first', () => {
  it('creates once and converges on a repeat', async () => {
    const first = await getOrCreateConnectorAuth(db, 'mcp-user-a', 'notion');
    const second = await getOrCreateConnectorAuth(db, 'mcp-user-a', 'notion');
    expect(second.id).toBe(first.id);
  });

  it('converges under two genuinely concurrent callbacks', async () => {
    const [a, b, c] = await Promise.all([
      getOrCreateConnectorAuth(db, 'mcp-user-race', 'linear'),
      getOrCreateConnectorAuth(db, 'mcp-user-race', 'linear'),
      getOrCreateConnectorAuth(db, 'mcp-user-race', 'linear'),
    ]);
    expect(b.id).toBe(a.id);
    expect(c.id).toBe(a.id);

    const rows = await db
      .select({ id: mcpConnectorAuths.id })
      .from(mcpConnectorAuths)
      .where(eq(mcpConnectorAuths.oxyUserId, 'mcp-user-race'));
    expect(rows).toHaveLength(1);
  });

  it('keeps the same user on a different server apart', async () => {
    const notion = await getOrCreateConnectorAuth(db, 'mcp-user-a', 'notion');
    const github = await getOrCreateConnectorAuth(db, 'mcp-user-a', 'github');
    expect(github.id).not.toBe(notion.id);
  });

  it('does not clobber a record the winner has already written into', async () => {
    /**
     * `DO NOTHING` rather than `DO UPDATE`: the loser of the race must not
     * overwrite tokens the winner just stored. `$setOnInsert` had the same
     * property, and losing it would log a user out mid-authorization.
     */
    const row = await getOrCreateConnectorAuth(db, 'mcp-user-b', 'notion');
    await updateConnectorAuth(db, row.id, { tokens: 'already-here' });

    const again = await getOrCreateConnectorAuth(db, 'mcp-user-b', 'notion');
    expect(again.tokens).toBe('already-here');
  });
});

describe('an update writes only the field it was given', () => {
  it('leaves the other three alone', async () => {
    const row = await getOrCreateConnectorAuth(db, 'mcp-user-c', 'notion');
    await updateConnectorAuth(db, row.id, {
      clientInformation: 'ci',
      tokens: 'tk',
      codeVerifier: 'cv',
    });

    await updateConnectorAuth(db, row.id, { tokens: 'tk2' });

    const after = await getOrCreateConnectorAuth(db, 'mcp-user-c', 'notion');
    expect(after).toMatchObject({
      clientInformation: 'ci',
      tokens: 'tk2',
      codeVerifier: 'cv',
    });
  });

  it('is a no-op for an empty update', async () => {
    const row = await getOrCreateConnectorAuth(db, 'mcp-user-c', 'notion');
    await updateConnectorAuth(db, row.id, {});
    const after = await getOrCreateConnectorAuth(db, 'mcp-user-c', 'notion');
    expect(after.tokens).toBe('tk2');
  });
});

describe('secrets reach the column as ciphertext, and only as ciphertext', () => {
  it('stores tokens encrypted and reads them back intact', async () => {
    const tokens = { access_token: 'super-secret-access', token_type: 'bearer' };
    await provider('mcp-enc-user', 'notion').saveTokens(tokens);

    const stored = await rawRow('mcp-enc-user', 'notion');
    expect(stored?.tokens).toMatch(WIRE_FORMAT);
    // The load-bearing negative: the plaintext must not be in the column.
    expect(stored?.tokens).not.toContain('super-secret-access');
    // …and its positive control: decrypting ONCE yields the original. A
    // double-encrypting column would give back another ciphertext here.
    expect(JSON.parse(decrypt(stored?.tokens ?? ''))).toEqual(tokens);

    // A FRESH provider, so this proves the value reached Postgres rather than
    // living in the first instance's in-memory copy.
    expect(await provider('mcp-enc-user', 'notion').tokens()).toEqual(tokens);
  });

  it('stores the DCR client information and the PKCE verifier the same way', async () => {
    const info = { client_id: 'dcr-client-id', client_secret: 'dcr-secret' };
    const p = provider('mcp-enc-user', 'github');
    await p.saveClientInformation(info);
    await p.saveCodeVerifier('pkce-verifier-value');

    const stored = await rawRow('mcp-enc-user', 'github');
    expect(stored?.clientInformation).toMatch(WIRE_FORMAT);
    expect(stored?.clientInformation).not.toContain('dcr-secret');
    expect(stored?.codeVerifier).toMatch(WIRE_FORMAT);
    expect(stored?.codeVerifier).not.toContain('pkce-verifier-value');

    const fresh = provider('mcp-enc-user', 'github');
    expect(await fresh.clientInformation()).toEqual(info);
    expect(await fresh.codeVerifier()).toBe('pkce-verifier-value');
  });

  it('stores the authorization URL in the CLEAR, deliberately', async () => {
    /**
     * The contrast that makes the assertions above mean something: this column
     * is NOT protected and NOT encrypted — it is where the user is sent and it
     * carries no bearer. If everything came back as ciphertext regardless, the
     * tests above would pass for the wrong reason.
     */
    const url = 'https://notion.example/oauth/authorize?state=state-token';
    await provider('mcp-enc-user', 'linear').redirectToAuthorization(new URL(url));

    const stored = await rawRow('mcp-enc-user', 'linear');
    expect(stored?.authorizationUrl).toBe(url);
    expect(stored?.authorizationUrl).not.toMatch(WIRE_FORMAT);
  });

  it('reads a value the OTHER process wrote, byte format and all', async () => {
    /**
     * `packages/api` and this service share `TOKEN_ENCRYPTION_KEY` on purpose.
     * The ciphertext below is built by an independent implementation of the
     * same wire format, so this fails the moment the two stop agreeing.
     */
    const tokens = { access_token: 'written-elsewhere' };
    const row = await getOrCreateConnectorAuth(db, 'mcp-cross-process', 'notion');
    await updateConnectorAuth(db, row.id, {
      tokens: encryptLikeTheOtherProcess(JSON.stringify(tokens)),
    });

    expect(await provider('mcp-cross-process', 'notion').tokens()).toEqual(tokens);
  });
});

describe('an absent secret is absent, not an empty one', () => {
  it('returns undefined for tokens and client information that were never saved', async () => {
    const p = provider('mcp-empty-user', 'notion');
    expect(await p.tokens()).toBeUndefined();
    expect(await p.clientInformation()).toBeUndefined();
  });

  it('refuses to invent a PKCE verifier', async () => {
    await expect(provider('mcp-empty-user', 'notion').codeVerifier()).rejects.toThrow(
      'No PKCE code verifier persisted for this OAuth session',
    );
  });

  it('returns one as soon as there is one, so the refusal is not unconditional', async () => {
    const p = provider('mcp-empty-user', 'notion');
    await p.saveCodeVerifier('now-there-is-one');
    expect(await provider('mcp-empty-user', 'notion').codeVerifier()).toBe('now-there-is-one');
  });
});
