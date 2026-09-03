import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import {
  PRODUCT_PROMPT_BY_KAANA_PROFILE,
  PRODUCT_PROMPT_PROFILE_IDS,
  getProductPromptId,
} from '../product-prompt-registry.js';
import { KAANA_ROUTING_PROFILE_IDS } from '../routing/kaana-profiles.js';
import { ROUTING_PRESETS } from '../routing/presets.js';

const PROMPT_ROOT = fileURLToPath(new URL('../../../prompts/', import.meta.url));

describe('product prompt registry', () => {
  it('covers every canonical Kaana profile exactly once', () => {
    expect([...PRODUCT_PROMPT_PROFILE_IDS].sort()).toEqual([...KAANA_ROUTING_PROFILE_IDS].sort());
    expect(Object.keys(PRODUCT_PROMPT_BY_KAANA_PROFILE).sort()).toEqual([...KAANA_ROUTING_PROFILE_IDS].sort());
    expect(ROUTING_PRESETS.flatMap((preset) => preset.profileIds).sort()).toEqual(
      [...KAANA_ROUTING_PROFILE_IDS].sort(),
    );
  });

  it('uses semantic product prompt ids, never inference ids', () => {
    for (const [profileId, promptId] of Object.entries(PRODUCT_PROMPT_BY_KAANA_PROFILE)) {
      expect(promptId, profileId).not.toBe(profileId);
      expect(promptId, profileId).not.toMatch(/^kaana-/);
      expect(existsSync(`${PROMPT_ROOT}${promptId}.md`), `prompts/${promptId}.md is missing`).toBe(true);
    }
  });

  it('keeps pro-max and extended reasoning as different product instructions', () => {
    expect(getProductPromptId('kaana-v1-pro-max')).toBe('pro-max');
    expect(getProductPromptId('kaana-v1-thinking')).toBe('extended-reasoning');
  });

  it('does not invent a prompt for another identifier', () => {
    expect(getProductPromptId('alia-v1')).toBeNull();
    expect(getProductPromptId('profile:v1')).toBeNull();
    expect(getProductPromptId('openai/gpt-4o')).toBeNull();
  });
});
