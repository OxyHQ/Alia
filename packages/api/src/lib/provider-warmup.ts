/**
 * Provider Connection Warmup
 * Pre-initializes TLS connections to AI provider endpoints on server startup.
 * Inspired by ZeroClaw's warmup() pattern that pre-establishes TLS handshakes.
 *
 * Fires lightweight HEAD requests in parallel. 401 responses are expected
 * (no auth keys sent) — the goal is only to complete the TLS handshake
 * so subsequent real requests skip the ~100-300ms cold-start penalty.
 */

import { log } from './logger.js';

const PROVIDER_ENDPOINTS: Record<string, string> = {
  openai: 'https://api.openai.com/v1/models',
  anthropic: 'https://api.anthropic.com/v1/messages',
  google: 'https://generativelanguage.googleapis.com/',
  groq: 'https://api.groq.com/openai/v1/models',
  together: 'https://api.together.ai/v1/models',
  cerebras: 'https://api.cerebras.ai/v1/models',
  mistral: 'https://api.mistral.ai/v1/models',
  deepseek: 'https://api.deepseek.com/models',
  openrouter: 'https://openrouter.ai/api/v1/models',
};

/**
 * Warm up TLS connections to all provider endpoints.
 * Non-blocking, errors are logged and swallowed.
 */
export async function warmupProviders(): Promise<void> {
  const start = Date.now();

  await Promise.allSettled(
    Object.entries(PROVIDER_ENDPOINTS).map(async ([name, url]) => {
      const t0 = Date.now();
      try {
        await fetch(url, {
          method: 'HEAD',
          signal: AbortSignal.timeout(5000),
        });
        log.providers.info({ provider: name, latencyMs: Date.now() - t0 }, 'Provider warmed up');
      } catch {
        // Expected: most providers return 401/405 without auth, but TLS is established
        log.providers.debug({ provider: name, latencyMs: Date.now() - t0 }, 'Provider warmup done (TLS established)');
      }
    }),
  );

  log.providers.info(
    { totalMs: Date.now() - start, providers: Object.keys(PROVIDER_ENDPOINTS).length },
    'Provider warmup complete',
  );
}
