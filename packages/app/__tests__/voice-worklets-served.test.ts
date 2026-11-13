import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Alia's web app keeps serving the voice worklets `@alia.onl/sdk` named, to the apps that still embed
 * that package: each file is named by its content hash, and none is ever replaced or removed,
 * because an app keeps naming the revision its SDK release was built with. `@gemies/sdk` loads its
 * worklets from `gemies.ai` (OxyHQ/Gemies), so nothing new is added here; the files go once
 * `api.alia.onl` does (Gemies ADR 0034, phase 8).
 */

const SERVED = join(__dirname, '..', 'public', 'sdk', 'voice-worklets');
const hashOf = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex').slice(0, 16);

describe('served voice worklets', () => {
  it('names every served revision by its own content hash', () => {
    const files = readdirSync(SERVED);
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      expect(file).toMatch(/^[0-9a-f]{16}\.js$/);
      expect(hashOf(readFileSync(join(SERVED, file)))).toBe(file.replace(/\.js$/, ''));
    }
  });
});
