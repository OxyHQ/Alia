import { describe, expect, it } from 'vitest';

import { buildCoverPrompt, generateCoverArt } from '../cover-art.js';

describe('cover art after the Kaana cutover', () => {
  it('keeps the prompt product-specific and free of provider routing', () => {
    const prompt = buildCoverPrompt('Daily Orbit', 'Space news', 'news');
    expect(prompt).toContain('Daily Orbit');
    expect(prompt).toContain('Absolutely no text');
    expect(prompt).not.toMatch(/openai|replicate|fal\b/i);
  });

  it('does not fail series creation while hosted image generation is unavailable', async () => {
    await expect(generateCoverArt('Daily Orbit', 'Space news', 'news')).resolves.toBeNull();
  });
});
