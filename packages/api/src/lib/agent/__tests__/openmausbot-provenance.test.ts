import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('OpenMausBot port provenance', () => {
  it('pins every reused source outside enterprise with a sha256', () => {
    const manifest = JSON.parse(readFileSync(resolve(import.meta.dirname, '../../../../../../openmausbot-port.json'), 'utf8')) as {
      commit: string;
      ports: Array<{ source: string; sourceSha256: string; destination: string }>;
    };
    expect(manifest.commit).toMatch(/^[a-f0-9]{40}$/);
    expect(manifest.ports.length).toBeGreaterThan(0);
    for (const port of manifest.ports) {
      expect(port.source).not.toMatch(/(^|\/)enterprise\//);
      expect(port.sourceSha256).toMatch(/^[a-f0-9]{64}$/);
      expect(port.destination).toMatch(/^packages\/api\/src\//);
    }
  });
});
