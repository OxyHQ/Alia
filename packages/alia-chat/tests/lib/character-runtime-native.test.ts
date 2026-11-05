import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const nativePath = fileURLToPath(
  new URL('../../src/lib/character-runtime.native.ts', import.meta.url),
);
function loadNative(runtime: { AVATAR_RUNTIME_REVISION: string }) {
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
      if (name === '@oxy.so/bloom/agent-avatar/runtime-revision') return runtime;
      throw new Error(`Unexpected dependency: ${name}`);
    },
  });
  return { url: exports.ALIA_CHARACTER_RUNTIME_URL, seen };
}
describe('native default avatar runtime', () => {
  it('pins the installed neutral Bloom revision without loading its GPU graph', () => {
    const revision = 'a'.repeat(64);
    expect(loadNative({ AVATAR_RUNTIME_REVISION: revision })).toEqual({
      url: `https://alia.onl/bloom-character/releases/${revision}/runtime.mjs`,
      seen: ['@oxy.so/bloom/agent-avatar/runtime-revision', './origins'],
    });
  });
  it('keeps the web/server module independent of native imports', () => {
    const source = readFileSync(nativePath.replace('.native.ts', '.ts'), 'utf8');
    expect(source).not.toContain('runtime-revision');
    expect(source).not.toContain('react-native');
  });
  it('agrees with the installed Bloom runtime without an optional package or skipped assertion', () => {
    const require = createRequire(import.meta.url);
    const runtime = require('@oxy.so/bloom/agent-avatar/runtime-revision') as {
      AVATAR_RUNTIME_REVISION: string;
    };
    expect(runtime.AVATAR_RUNTIME_REVISION).toMatch(/^[a-f0-9]{64}$/);
    expect(loadNative(runtime).url).toBe(
      `https://alia.onl/bloom-character/releases/${runtime.AVATAR_RUNTIME_REVISION}/runtime.mjs`,
    );
  });
});
