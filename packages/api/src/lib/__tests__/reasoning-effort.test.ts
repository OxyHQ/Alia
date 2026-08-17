import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { SystemPromptBuilder } from '../system-prompt-builder.js';

/**
 * Extended reasoning is a REQUEST PARAMETER, not a model identity
 * (#139 workstream 4).
 *
 * `alia-v1-thinking` and `alia-v1-pro-max` route to the same nine candidates at
 * the same credit multiplier. The only thing that differed was which prompt
 * file their model id loaded — so "extended thinking" was sold as a model when
 * it is a setting. The epic says it plainly: *"use runtime parameters/presets
 * for reasoning level where the underlying weights are identical"* and *"do not
 * create separate model IDs merely for a system prompt or reasoning-effort
 * setting."*
 *
 * `thinkingMode` was already a request parameter and already drove the
 * provider-level thinking budget (`lib/chat/model-config.ts`). What it did not
 * do was select the reasoning PROMPT — that only ever came from naming the
 * alias. It does now, so any profile can carry extended reasoning and the alias
 * is redundant rather than merely unadvertised.
 *
 * The real `SystemPromptBuilder.build` runs and the real prompt files are read
 * off disk. Nothing here re-implements the layering it measures.
 */

const REPO_ROOT = path.resolve(fileURLToPath(new URL('../../../../../', import.meta.url)));

/** The file the parameter selects, read from disk so the assertion is about content. */
const REASONING_PROMPT = readFileSync(
  path.join(REPO_ROOT, 'packages/api/prompts/alia-v1-thinking.md'),
  'utf8',
).trim();

/** A distinctive sentence from it, so a match cannot be an accident of shared boilerplate. */
const REASONING_MARKER = 'extended reasoning capabilities';

async function build(aliasModelId: string, thinkingMode: boolean | undefined): Promise<string> {
  return SystemPromptBuilder.build({ aliasModelId, isDirectUserSession: false, thinkingMode });
}

describe('the fixture is a real prompt with something to look for', () => {
  it('the reasoning prompt exists and carries its marker', () => {
    // Without this, every assertion below passes against an empty file.
    expect(REASONING_PROMPT.length).toBeGreaterThan(200);
    expect(REASONING_PROMPT).toContain(REASONING_MARKER);
  });

  it('the marker is not in the profile it will be layered onto', () => {
    // The control that makes "the marker appeared" mean the layer was added,
    // rather than it having been there all along.
    const proMax = readFileSync(path.join(REPO_ROOT, 'packages/api/prompts/alia-v1-pro-max.md'), 'utf8');
    expect(proMax).not.toContain(REASONING_MARKER);
  });
});

describe('any profile can carry extended reasoning', () => {
  it('adds the layer when the request asks for it', async () => {
    const withReasoning = await build('alia-v1-pro-max', true);
    expect(withReasoning).toContain(REASONING_MARKER);
  });

  it('leaves it out when the request does not', async () => {
    // Both the explicit `false` and the absent case, because a parameter that
    // is always on is not a parameter.
    expect(await build('alia-v1-pro-max', false)).not.toContain(REASONING_MARKER);
    expect(await build('alia-v1-pro-max', undefined)).not.toContain(REASONING_MARKER);
  });

  it('works on a profile that is nothing to do with the retired alias', async () => {
    // The point of it being a parameter: extended reasoning is no longer
    // reachable only through one tier's identity.
    const lite = await build('alia-lite', true);
    expect(lite).toContain(REASONING_MARKER);
    expect(await build('alia-lite', false)).not.toContain(REASONING_MARKER);
  });
});

describe('the retired alias keeps its behaviour and gains no duplicate', () => {
  it('still loads the reasoning prompt when named directly', async () => {
    // It still resolves, so a caller still holding it is unaffected — that is
    // what "advertised nowhere" means, as opposed to removed.
    expect(await build('alia-v1-thinking', undefined)).toContain(REASONING_MARKER);
  });

  it('does not say it twice when the parameter is also set', async () => {
    // `loadBasePrompt` already loaded this exact file for that id. Layering it
    // again would tell the model the same thing in two voices.
    const both = await build('alia-v1-thinking', true);
    const occurrences = both.split(REASONING_MARKER).length - 1;
    expect(occurrences).toBe(1);
  });

  it('is now expressible without naming it at all', async () => {
    // The redundancy, stated as an equality rather than described: the alias's
    // whole distinguishing content is reachable from the profile it shares plus
    // the parameter. Compared on the reasoning layer, since the two entries
    // legitimately differ in their own identity blurb.
    const viaAlias = await build('alia-v1-thinking', undefined);
    const viaParameter = await build('alia-v1-pro-max', true);
    for (const line of REASONING_PROMPT.split('\n').filter((l) => l.trim().length > 20)) {
      expect(viaAlias, line).toContain(line.trim());
      expect(viaParameter, line).toContain(line.trim());
    }
  });
});
