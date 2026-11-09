import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildIdentityGuard } from '../identity-guard.js';

/**
 * The model imitates the prompt it reads. Studies of LLM prose find the em dash far more frequent
 * in model output than in human writing, and an explicit ban alone does not always remove it, so
 * the prompts the model sees must not use the dashes themselves. The only place the character may
 * appear is the base prompt's own rule, which has to name it.
 */
const PROMPTS = join(import.meta.dirname, '../../../prompts');
const DASHES = /[—–]/g;

describe('the prompts the model reads', () => {
  it('forbid the em dash and the en dash explicitly, in the base prompt', () => {
    const base = readFileSync(join(PROMPTS, 'base.md'), 'utf8');
    expect(base).toMatch(/em dash \(—\) and the en dash \(–\) are forbidden/);
  });

  it('use no dash as punctuation, except the base prompt naming the ones it forbids', () => {
    const offenders: string[] = [];
    for (const file of readdirSync(PROMPTS).filter((name) => name.endsWith('.md'))) {
      const text = readFileSync(join(PROMPTS, file), 'utf8')
        // The one sentence that has to name the characters to forbid them.
        .replace(/The em dash \(—\) and the en dash \(–\) are forbidden/, '');
      const found = text.match(DASHES);
      if (found) offenders.push(`${file}: ${found.length}`);
    }
    expect(offenders).toEqual([]);
  });

  it('use none in the identity guard that opens every turn, for Alia or an agent', () => {
    expect(buildIdentityGuard({ agentName: 'Alia' })).not.toMatch(DASHES);
    expect(buildIdentityGuard({ agentName: 'Nadia' })).not.toMatch(DASHES);
  });
});
