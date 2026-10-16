import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Alia's web app serves the SDK's voice worklets to every app that embeds the SDK
 * (`scripts/stamp-voice-worklets.mjs`): each file is named by its content hash, and none is ever
 * replaced or removed, because an app keeps naming the revision its SDK release was built with.
 */

const SERVED = join(__dirname, '..', 'public', 'sdk', 'voice-worklets');
const hashOf = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex').slice(0, 16);

describe('served voice worklets', () => {
  it("serves the SDK's current worklets under their revision", () => {
    // The SDK's own test holds `VOICE_WORKLETS_REVISION` to this same hash of the same file.
    const sdkRoot = dirname(createRequire(__filename).resolve('@alia.onl/sdk/package.json'));
    const source = readFileSync(join(sdkRoot, 'worklets', 'voice-processors.js'));
    // Missing? `bun run --filter @alia/app stamp:voice-worklets`.
    expect(readdirSync(SERVED)).toContain(`${hashOf(source)}.js`);
  });

  it('names every served revision by its own content hash', () => {
    const files = readdirSync(SERVED);
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      expect(file).toMatch(/^[0-9a-f]{16}\.js$/);
      expect(hashOf(readFileSync(join(SERVED, file)))).toBe(file.replace(/\.js$/, ''));
    }
  });
});
