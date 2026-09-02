import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(fileURLToPath(new URL('../../../../../../', import.meta.url)));
const read = (relativePath: string): string =>
  readFileSync(path.join(REPO_ROOT, relativePath), 'utf8');

const retiredRuntimeFiles = [
  'kaana.ts',
  'kaana-client.ts',
  'kaana-transport.ts',
  'kaana-endpoint.ts',
  'kaana-request.ts',
  'kaana-error.ts',
  'kaana-connectivity.ts',
  'kaana-catalogue.ts',
  'kaana-openai-adapter.ts',
  'kaana-boot-check.ts',
] as const;

describe('Alia to Oxy to Kaana boundary', () => {
  it('has no direct Kaana client, signer or bespoke wire transport', () => {
    for (const file of retiredRuntimeFiles) {
      expect(existsSync(path.join(REPO_ROOT, 'packages/api/src/lib/inference', file)), file).toBe(false);
    }
  });

  it('uses the published OxyInferenceClient', () => {
    const source = read('packages/api/src/lib/inference/oxy-inference.ts');
    expect(source).toContain("import { OxyInferenceClient } from '@oxyhq/core'");
    expect(source).toContain('new OxyInferenceClient');
  });

  it('does not configure direct Kaana signing or a direct Kaana origin', () => {
    const activeFiles = [
      '.github/workflows/deploy-aws.yml',
      'packages/api/.env.example',
      'packages/api/src/lib/inference/oxy-inference.ts',
      'packages/api/src/lib/inference/oxy-inference-credential.ts',
    ];
    const forbidden = [
      'KAANA_EDGE_SIGNING_PRIVATE_KEY',
      'KAANA_EDGE_KEY_ID',
      'KAANA_BASE_URL',
      '/internal/v1/inference',
      'x-kaana-signature',
    ];
    for (const file of activeFiles) {
      const source = read(file);
      for (const token of forbidden) expect(source, `${file}: ${token}`).not.toContain(token);
    }
  });
});
