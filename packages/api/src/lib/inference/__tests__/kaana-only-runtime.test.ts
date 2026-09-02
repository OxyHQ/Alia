import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import {
  directProviderModeFailure,
  GATEWAY_URL_ENV,
  PROVIDER_CREDENTIAL_ENV,
} from '../direct-provider-guard.js';
import {
  KaanaCapabilityUnavailableError,
  kaanaCapabilityUnavailable,
} from '../hosted-capability-error.js';

const API_SRC = path.resolve(fileURLToPath(new URL('../../../', import.meta.url)));

function source(relative: string): string {
  return readFileSync(path.join(API_SRC, relative), 'utf8');
}

const HOSTED_RUNTIME_FILES = [
  'lib/chat-core.ts',
  'lib/chat/provider-loop.ts',
  'lib/chat/stream-runner.ts',
  'lib/gateway-client.ts',
  'lib/image-generation.ts',
  'lib/synthesize-sound-effect.ts',
  'lib/synthesize-speech.ts',
  'lib/memory/embeddings.ts',
  'routes/v1/audio.ts',
  'routes/v1/chat-completions.ts',
  'routes/v1/images.ts',
  'routes/v1/voice.ts',
  'routes/canvas/execute.ts',
] as const;

describe('Kaana-only hosted inference architecture', () => {
  it('has no cutover switch or gateway inference mode', () => {
    const runtime = HOSTED_RUNTIME_FILES.map((file) => source(file)).join('\n');
    const retiredFlag = ['ALIA', 'KAANA', 'CLIENT', 'ENABLED'].join('_');
    const retiredModule = ['kaana', 'cutover'].join('-');
    expect(runtime).not.toContain(retiredFlag);
    expect(runtime).not.toContain(retiredModule);
    expect(runtime).not.toContain('GATEWAY_API_URL');
    expect(source('lib/inference/oxy-inference-boot-check.ts')).not.toContain(
      ['is', 'Kaana', 'Client', 'Enabled'].join(''),
    );
  });

  it('does not import the retired provider inference tree', () => {
    const forbidden = [
      'internal/providers/lib/provider-api',
      'internal/providers/lib/key-manager',
      'internal/providers/lib/fallback-engine',
      'internal/providers/lib/model-resolver',
      'internal/providers/providers/',
      '@ai-sdk/anthropic',
      '@ai-sdk/google',
      'createOpenAICompatible',
    ] as const;

    for (const file of HOSTED_RUNTIME_FILES) {
      const text = source(file);
      for (const token of forbidden) expect(text, `${file}: ${token}`).not.toContain(token);
    }
  });

  it('keeps createOpenAI exclusively behind the local user-runtime branch', () => {
    const chatCore = source('lib/chat-core.ts');
    expect(chatCore.match(/createOpenAI\s*\(/g)).toHaveLength(1);
    expect(chatCore).toContain('resolved.provider === USER_RUNTIME_PROVIDER');
    expect(chatCore).toContain('fetch: userRuntimeFetch(binding)');
    expect(chatCore).toContain('return kaanaLanguageModel');
    expect(chatCore).not.toMatch(/apiKey:\s*process\.env/);
  });

  it('refuses every provider-shaped environment variable unconditionally', () => {
    for (const variable of PROVIDER_CREDENTIAL_ENV) {
      const failure = directProviderModeFailure({ [variable]: 'adversarial-value' });
      expect(failure, variable).toContain(variable);
    }
    expect(directProviderModeFailure({ [GATEWAY_URL_ENV]: 'https://gateway.invalid' })).toContain(
      GATEWAY_URL_ENV,
    );
  });

  it('uses one stable typed refusal for unsupported hosted modalities', () => {
    const error = kaanaCapabilityUnavailable('speech_transcription');
    expect(error).toBeInstanceOf(KaanaCapabilityUnavailableError);
    expect(error.code).toBe('KAANA_CAPABILITY_UNAVAILABLE');
    expect(error.httpStatus).toBe(503);
    expect(error.capability).toBe('speech_transcription');
  });
});
