import { describe, it, expect, vi } from 'vitest';

vi.mock('../../internal/providers/lib/provider-names.js', () => ({
  PROVIDER_NAMES: [
    'openai', 'anthropic', 'google', 'groq', 'mistral', 'deepseek',
    'together', 'replicate', 'cerebras', 'cloudflare', 'openrouter',
    'cohere', 'fireworks', 'perplexity', 'xai', 'sambanova',
    'hyperbolic', 'novita', 'digitalocean',
  ],
}));

vi.mock('../agent/secret-scanner.js', () => ({
  redactSecrets: vi.fn((msg: string) => ({
    redacted: msg.replace(/sk-[a-zA-Z0-9]{10,}/g, '[REDACTED]'),
    secretsFound: [],
  })),
}));

import { sanitizeMessage, getSafeErrorMessage, sanitizeFull } from '../errors/sanitize.js';

describe('sanitizeMessage', () => {
  it('strips known provider names', () => {
    expect(sanitizeMessage('OpenAI returned a 429 error')).toBe('Clarity returned a 429 error');
    expect(sanitizeMessage('Anthropic rate limit exceeded')).toBe('Clarity rate limit exceeded');
    expect(sanitizeMessage('Google API quota exhausted')).toBe('Clarity API quota exhausted');
  });

  it('strips provider names case-insensitively', () => {
    expect(sanitizeMessage('OPENAI error')).toBe('Clarity error');
    expect(sanitizeMessage('groQ timeout')).toBe('Clarity timeout');
  });

  it('strips model identifiers', () => {
    // gpt- prefix is in PROVIDER_PATTERNS, so "gpt-4o-mini" first becomes "Clarity4o-mini"
    // then the regex catches remaining full model IDs
    const result1 = sanitizeMessage('Model gpt-4o-mini is unavailable');
    expect(result1).not.toContain('gpt');

    // claude is in PROVIDER_PATTERNS, so "claude-sonnet-4" is stripped
    const result2 = sanitizeMessage('claude-sonnet-4 returned an error');
    expect(result2).not.toContain('claude');

    // gemini is in PROVIDER_PATTERNS
    const result3 = sanitizeMessage('gemini-2.5-flash rate limited');
    expect(result3).not.toContain('gemini');
  });

  it('returns original message when no providers are mentioned', () => {
    expect(sanitizeMessage('Request timed out')).toBe('Request timed out');
  });

  it('strips multiple providers in one message', () => {
    const result = sanitizeMessage('Tried OpenAI then Anthropic, both failed');
    expect(result).toBe('Tried Clarity then Clarity, both failed');
  });
});

describe('getSafeErrorMessage', () => {
  it('returns sanitized message from Error objects', () => {
    const error = new Error('OpenAI API returned 500');
    expect(getSafeErrorMessage(error, 'fallback')).toBe('Clarity API returned 500');
  });

  it('returns fallback for non-Error values', () => {
    expect(getSafeErrorMessage('string error', 'Something went wrong')).toBe('Something went wrong');
    expect(getSafeErrorMessage(null, 'Something went wrong')).toBe('Something went wrong');
    expect(getSafeErrorMessage(undefined, 'Something went wrong')).toBe('Something went wrong');
    expect(getSafeErrorMessage(42, 'Something went wrong')).toBe('Something went wrong');
  });

  it('sanitizes the fallback too', () => {
    expect(getSafeErrorMessage(null, 'OpenAI failed')).toBe('Clarity failed');
  });
});

describe('sanitizeFull', () => {
  it('strips both provider names and secrets', () => {
    const result = sanitizeFull('OpenAI key sk-abcdefghijklmnop leaked');
    expect(result).toBe('Clarity key [REDACTED] leaked');
  });

  it('handles messages with only provider names', () => {
    expect(sanitizeFull('Anthropic error')).toBe('Clarity error');
  });

  it('handles messages with only secrets', () => {
    const result = sanitizeFull('Key sk-abcdefghijklmnop found');
    expect(result).toBe('Key [REDACTED] found');
  });
});
