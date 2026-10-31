import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const nativePath = fileURLToPath(
  new URL('../../src/lib/character-runtime.native.ts', import.meta.url),
);
function loadNative(companion?: { AVATAR_RUNTIME_REVISION: string }) {
  const source = ts.transpileModule(readFileSync(nativePath, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS },
  }).outputText;
  const exports: Record<string, unknown> = {};
  const seen: string[] = [];
  runInNewContext(source, {
    exports,
    require(name: string) {
      seen.push(name);
      if (name === './origins') return { ALIA_WEB_ORIGIN: 'https://alia.onl' };
      if (name === '@oxy.so/bloom-avatar-native/runtime-revision' && companion) return companion;
      throw new Error('Optional module missing');
    },
  });
  return { url: exports.ALIA_CHARACTER_RUNTIME_URL, seen };
}
describe('native default avatar runtime', () => {
  it('pins the installed neutral companion revision without loading its GPU graph', () => {
    const revision = 'a'.repeat(64);
    expect(loadNative({ AVATAR_RUNTIME_REVISION: revision })).toEqual({
      url: `https://alia.onl/bloom-character/releases/${revision}/runtime.mjs`,
      seen: ['./origins', '@oxy.so/bloom-avatar-native/runtime-revision'],
    });
  });
  it('keeps the WebView fallback when the optional companion is absent or invalid', () => {
    expect(loadNative().url).toBe('https://alia.onl/bloom-character/runtime.mjs');
    expect(loadNative({ AVATAR_RUNTIME_REVISION: '../bad' }).url).toBe(
      'https://alia.onl/bloom-character/runtime.mjs',
    );
  });
  it('keeps the web/server module independent of native imports', () => {
    const source = readFileSync(nativePath.replace('.native.ts', '.ts'), 'utf8');
    expect(source).not.toContain('bloom-avatar-native');
    expect(source).not.toContain('react-native');
  });
  it('agrees with the actual optional published package when installed', () => {
    const require = createRequire(import.meta.url);
    let companion: { AVATAR_RUNTIME_REVISION: string };
    try {
      companion = require('@oxy.so/bloom-avatar-native/runtime-revision');
    } catch {
      return;
    }
    expect(loadNative(companion).url).toContain(`/releases/${companion.AVATAR_RUNTIME_REVISION}/`);
  });
});
