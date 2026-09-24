import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { constraintNameOf, isCheckViolation } from '@oxy.so/db';
import { closePostgres, connectPostgres, type ApiDatabase } from '../index';
import { apiKeyUsage } from '../schema/telemetry';

/**
 * `api_key_usage`, against a REAL server: the CHECKs a mocked insert would
 * accept, and the null key/app a session-authenticated call records.
 */

let db: ApiDatabase;

beforeAll(() => {
  const connected = connectPostgres(process.env.DATABASE_URL);
  if (!connected) throw new Error('DATABASE_URL is not set; vitest.pg.globalSetup.ts must run.');
  db = connected;
});

afterAll(async () => {
  await closePostgres();
});

describe('developer API usage is recorded with its own clock', () => {
  it('refuses an HTTP method this API does not expose', async () => {
    const insert = db.execute(sql`
      insert into ${apiKeyUsage} (id, oxy_user_id, endpoint, method, status_code, timestamp)
      values ('aku-bad', 'oxy-user-1', '/v1/chat', 'TRACE', 200, now())
    `);

    await expect(insert).rejects.toSatisfy((error: unknown) => {
      expect(isCheckViolation(error)).toBe(true);
      expect(constraintNameOf(error)).toBe('api_key_usage_method_check');
      return true;
    });
  });

  it('accepts a session-authenticated call, which has neither key nor app', async () => {
    await db.insert(apiKeyUsage).values({
      id: 'aku-session',
      oxyUserId: 'oxy-user-1',
      authType: 'session',
      endpoint: '/v1/chat',
      method: 'POST',
      statusCode: 200,
      timestamp: new Date(),
    });

    const [row] = await db
      .select({ apiKeyId: apiKeyUsage.apiKeyId, authType: apiKeyUsage.authType })
      .from(apiKeyUsage)
      .where(eq(apiKeyUsage.id, 'aku-session'));

    expect(row?.apiKeyId).toBeNull();
    expect(row?.authType).toBe('session');
  });
});
