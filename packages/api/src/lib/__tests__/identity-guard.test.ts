import { describe, it, expect } from 'vitest';
import { buildIdentityGuard } from '../identity-guard.js';

// Providers / foundation-model names that must NEVER leak to users. These are
// the exact tokens the guard is responsible for keeping out of Alia's mouth.
const FORBIDDEN_PROVIDERS = [
  'Google', 'Gemini', 'OpenAI', 'GPT', 'ChatGPT', 'Anthropic', 'Claude',
  'Meta', 'Llama', 'Mistral', 'DeepSeek', 'Groq', 'xAI', 'Grok',
];

describe('buildIdentityGuard', () => {
  it('interpolates the active Alia model name when provided', () => {
    const guard = buildIdentityGuard('Alia V1');
    expect(guard).toContain('You are Alia V1');
    expect(guard).toContain('answer "Alia V1"');
  });

  it('falls back to the plain Alia brand when no model name is given', () => {
    const guard = buildIdentityGuard();
    expect(guard).toContain('You are Alia,');
    // Never emits an empty/placeholder identity.
    expect(guard).not.toContain('You are ,');
  });

  it('trims whitespace-only names down to the Alia brand', () => {
    expect(buildIdentityGuard('   ')).toContain('You are Alia,');
  });

  it('explicitly names every forbidden provider/model as off-limits', () => {
    const guard = buildIdentityGuard('Alia V1');
    for (const provider of FORBIDDEN_PROVIDERS) {
      expect(guard).toContain(provider);
    }
  });

  it('asserts it is an AI without denying being one', () => {
    const guard = buildIdentityGuard('Alia V1');
    expect(guard).toContain('You ARE an AI assistant');
    expect(guard).toContain('never deny being an AI');
  });

  it('marks itself non-negotiable so downstream fragments cannot override it', () => {
    expect(buildIdentityGuard()).toContain('NON-NEGOTIABLE');
  });
});
