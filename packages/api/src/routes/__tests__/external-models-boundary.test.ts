import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const API_SRC = path.resolve(fileURLToPath(new URL('../../', import.meta.url)));

describe('external-model leaderboard boundary', () => {
  it('is not an executable hosted-inference input', () => {
    for (const relative of [
      'lib/chat-core.ts',
      'lib/chat/provider-loop.ts',
      'lib/gateway-client.ts',
      'lib/inference/kaana-client.ts',
    ]) {
      expect(readFileSync(path.join(API_SRC, relative), 'utf8'), relative).not.toContain('externalModels');
    }
  });

  it('does not join leaderboard rows to executable routing configuration', () => {
    const schema = readFileSync(path.join(API_SRC, 'db/schema/providers.ts'), 'utf8');
    const start = schema.indexOf('export const externalModels = pgTable(');
    expect(start).toBeGreaterThan(-1);
    const end = schema.indexOf('export const', start + 20);
    const table = end === -1 ? schema.slice(start) : schema.slice(start, end);
    expect(table).not.toContain('references(');
    expect(table).not.toContain('routingProfiles');
    expect(table).not.toContain('modelConfigs');
  });
});
