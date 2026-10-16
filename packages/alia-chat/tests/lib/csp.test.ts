import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ALIA_SDK_CSP, withAliaSdkCsp } from '../../src/csp';
import { VOICE_WORKLETS_REVISION, VOICE_WORKLETS_URL } from '../../src/lib/voice-worklets';

const PACKAGE = join(__dirname, '..', '..');
const SRC = join(PACKAGE, 'src');

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return /\.(ts|tsx)$/.test(name) ? [path] : [];
  });
}

const declared = new Set(Object.values(ALIA_SDK_CSP).flat());

describe('@alia.onl/sdk/csp', () => {
  it('declares exactly what the SDK loads in production', () => {
    expect(ALIA_SDK_CSP).toEqual({
      connectSrc: ['https://api.alia.onl', 'wss://api.alia.onl', 'https://alia.onl'],
      scriptSrc: ['https://alia.onl', "'wasm-unsafe-eval'"],
      imgSrc: ['https://api.alia.onl', 'blob:'],
      mediaSrc: ['https://api.alia.onl'],
    });
  });

  it('declares every origin the SDK source names', () => {
    const named = sourceFiles(SRC).flatMap((file) =>
      [...readFileSync(file, 'utf8').matchAll(/\b(?:https?|wss?):\/\/[a-z0-9.-]+/gi)].map(
        ([origin]) => ({ file: relative(PACKAGE, file), origin }),
      ),
    );
    expect(named.length).toBeGreaterThan(0);
    expect(named.filter(({ origin }) => !declared.has(origin))).toEqual([]);
  });

  it('declares where the voice worklets come from', () => {
    const worklets = new URL(VOICE_WORKLETS_URL).origin;
    expect(ALIA_SDK_CSP.scriptSrc).toContain(worklets);
  });

  it("adds the SDK's sources to the host's, keeping every host directive and source", () => {
    expect(
      withAliaSdkCsp({ connectSrc: ['https://api.example.test'], frameSrc: ['https://x.test'] }),
    ).toEqual({
      connectSrc: [
        'https://api.example.test',
        'https://api.alia.onl',
        'wss://api.alia.onl',
        'https://alia.onl',
      ],
      frameSrc: ['https://x.test'],
      scriptSrc: ['https://alia.onl', "'wasm-unsafe-eval'"],
      imgSrc: ['https://api.alia.onl', 'blob:'],
      mediaSrc: ['https://api.alia.onl'],
    });
  });

  it('is a leaf entry: nothing it imports reaches React or React Native', () => {
    for (const file of ['src/csp.ts', 'src/lib/origins.ts', 'src/lib/voice-protocol.ts']) {
      const imports = [
        ...readFileSync(join(PACKAGE, file), 'utf8').matchAll(/^import (?!type).*from '([^']+)'/gm),
      ].map(([, specifier]) => specifier);
      expect(imports.filter((specifier) => /react/.test(specifier ?? ''))).toEqual([]);
    }
  });
});

describe('voice worklets', () => {
  it("are named by their content's hash", () => {
    const bytes = readFileSync(join(PACKAGE, 'worklets', 'voice-processors.js'));
    const hash = createHash('sha256').update(bytes).digest('hex').slice(0, 16);
    // Changed `worklets/voice-processors.js`? Set VOICE_WORKLETS_REVISION to this hash and run
    // `bun run --filter @alia/app stamp:voice-worklets` so the web app serves the new revision.
    expect(VOICE_WORKLETS_REVISION).toBe(hash);
  });
});
