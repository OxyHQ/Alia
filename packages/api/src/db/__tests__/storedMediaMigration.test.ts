import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const migrationPath = fileURLToPath(
  new URL('../../../drizzle/0032_stored_media_is_a_key.sql', import.meta.url),
);
const migration = readFileSync(migrationPath, 'utf8');
const quotedPatterns = [...migration.matchAll(/'((?:\^)?https:\/\/[^']+)'/g)].map(
  ([, pattern]) => pattern,
);

const OWN_BUCKET_PATTERN =
  '^https://oxy-alia-media-usw2-237343248947\\.s3\\.us-west-2\\.amazonaws\\.com/';
const OWN_BUCKET_SCAN_PATTERN = OWN_BUCKET_PATTERN.slice(1);

describe('the stored-media migration owns only Alia objects', () => {
  it('uses the exact live Alia bucket for every scalar and JSON rewrite', () => {
    expect(quotedPatterns.length).toBe(17);
    expect(quotedPatterns.filter((pattern) => pattern === OWN_BUCKET_PATTERN)).toHaveLength(16);
    // The sole unanchored occurrence prefilters a JSON array's serialized text;
    // each element is still rewritten by the anchored expression above.
    expect(quotedPatterns.filter((pattern) => pattern === OWN_BUCKET_SCAN_PATTERN)).toHaveLength(1);
    expect(new Set(quotedPatterns)).toEqual(
      new Set([OWN_BUCKET_PATTERN, OWN_BUCKET_SCAN_PATTERN]),
    );
  });

  it('strips Alia object addresses and preserves a foreign S3 avatar', () => {
    const ownKey = 'production/agents/avatar-123.png';
    const ownAddress =
      `https://oxy-alia-media-usw2-237343248947.s3.us-west-2.amazonaws.com/${ownKey}`;
    const foreignAddress =
      'https://customer-assets.s3.us-west-2.amazonaws.com/avatars/external.png';
    const pattern = new RegExp(OWN_BUCKET_PATTERN);

    expect(ownAddress.replace(pattern, '')).toBe(ownKey);
    expect(foreignAddress.replace(pattern, '')).toBe(foreignAddress);
  });
});
