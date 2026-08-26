import { describe, expect, it } from 'vitest';

import { SystemPromptBuilder } from '../system-prompt-builder.js';

/**
 * Where the two halves of Agent Skills land in the system message.
 *
 * The old feature had one arm here — a single prompt prepended above everything
 * — and NOTHING asserted it: the fixtures mocked the lookup to `undefined`, so a
 * skill that never reached the model would have passed every test in the repo.
 * This is that assertion, for both halves.
 *
 * The difference between them is authority, and it is the whole design:
 *
 *  - The INDEX is context. It says which skills exist, and is appended with
 *    everything else Alia knows about this turn.
 *  - The ACTIVE block is instructions the person asked for. It is prepended,
 *    above the base prompt, so it can shape how the turn is answered.
 *
 * Neither may sit above the identity guard, which is prepended last precisely so
 * that no skill can move it.
 */

const INDEX = '\n\n## Skills\n- pdf-processing: Extracts text from PDFs. Use when the user mentions PDFs.';
const ACTIVE = '# ACTIVE SKILLS\n\n## Skill: PDF Processing (pdf-processing, v1)\n\nUse pdfplumber.';

async function build(skills: { index: string; active: string } | null): Promise<string> {
  return SystemPromptBuilder.build({
    aliasModelId: 'alia-v1',
    isDirectUserSession: true,
    skills,
  });
}

describe('the skills index', () => {
  it('reaches the system message', async () => {
    const prompt = await build({ index: INDEX, active: '' });
    expect(prompt).toContain('## Skills');
    expect(prompt).toContain('- pdf-processing: Extracts text from PDFs.');
  });

  /**
   * The control. Without it every assertion above would also pass on a builder
   * that pasted the string in unconditionally, or on one that never removed it.
   */
  it('is absent when the turn has no skills', async () => {
    const prompt = await build(null);
    expect(prompt).not.toContain('## Skills');
    expect(prompt).not.toContain('pdf-processing');
  });

  it('is appended as context rather than prepended as authority', async () => {
    const prompt = await build({ index: INDEX, active: '' });
    const base = prompt.indexOf('Today is');
    expect(base).toBeGreaterThan(-1);
    expect(prompt.indexOf('## Skills')).toBeGreaterThan(base);
  });
});

describe('selected skills', () => {
  it('are prepended above the base prompt, where instructions belong', async () => {
    const prompt = await build({ index: '', active: ACTIVE });
    expect(prompt).toContain('Use pdfplumber.');
    expect(prompt.indexOf('# ACTIVE SKILLS')).toBeLessThan(prompt.indexOf('Today is'));
  });

  it('never sit above the identity guard', async () => {
    const prompt = await build({ index: INDEX, active: ACTIVE });
    // The guard is prepended LAST, so it is the first thing in the message.
    expect(prompt.indexOf('# ACTIVE SKILLS')).toBeGreaterThan(0);
    const guardEnd = prompt.indexOf('---');
    expect(prompt.indexOf('# ACTIVE SKILLS')).toBeGreaterThan(guardEnd);
  });

  it('can be present at the same time as the index', async () => {
    const prompt = await build({ index: INDEX, active: ACTIVE });
    expect(prompt).toContain('# ACTIVE SKILLS');
    expect(prompt).toContain('## Skills');
  });
});

/**
 * A developer key carries its owner's account, and an install belongs to that
 * account — so there is nothing here to withhold from one. The prompt this
 * replaced was gated on `isDirectUserSession`, which meant a person's own API
 * key could not use their own skills.
 */
describe('API-key sessions', () => {
  it('receive the same skills a direct session would', async () => {
    const prompt = await SystemPromptBuilder.build({
      aliasModelId: 'alia-v1',
      isDirectUserSession: false,
      skills: { index: INDEX, active: ACTIVE },
    });
    expect(prompt).toContain('## Skills');
    expect(prompt).toContain('# ACTIVE SKILLS');
  });
});
