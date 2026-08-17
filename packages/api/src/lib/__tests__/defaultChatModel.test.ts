/**
 * The default chat model has ONE owner — epic #139.
 *
 * Two functions called `getDefaultAliaModel` existed, in
 * `lib/gateway-client.ts` (`alia-lite`) and
 * `internal/providers/lib/model-resolver.ts` (`alia-v1`), disagreeing about what
 * a request that named no model gets. Nothing imported the second, so the wrong
 * answer was never returned — but nothing said so either, and the next caller to
 * reach for a default had even odds of importing it.
 *
 * These gates are the reason that cannot happen twice. They are of two kinds and
 * the difference matters:
 *
 *  - **an exact count**, not a floor, on how many defaults exist. A floor of
 *    `>= 1` is satisfied by the state this file exists to prevent;
 *  - **an agreement assertion** between two INDEPENDENT derivations of the
 *    default — a constant here, a minimisation over `creditMultiplier` there.
 *    A count alone cannot notice the single owner changing its answer.
 *
 * The frozen census at the end records every site that still restates an alias
 * literal instead of importing the owner. It is a FREEZE, not a ban: several of
 * those are legitimate (a voice route defaults to a voice alias) and one is a
 * live product divergence this PR deliberately does not decide. Freezing them
 * makes a new one, or a changed one, fail.
 */

import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { getDefaultAliaModel, getDefaultModelForCategory } from '../gateway-client.js';

const REPO_ROOT = path.resolve(fileURLToPath(new URL('../../../../../', import.meta.url)));

/**
 * Blank comments out IN PLACE so line numbers survive.
 *
 * Deleting them instead shifts every line after a block comment, which makes
 * the reported location of a hit fiction — measured while writing this file.
 */
function stripComments(source: string): string {
  const blank = (m: string) => m.replace(/[^\n]/g, ' ');
  return source.replace(/\/\*[\s\S]*?\*\//g, blank).replace(/\/\/[^\n]*/g, blank);
}

/**
 * Every tracked non-test `.ts` under the API source, read off git rather than a
 * hand list — a hand list is exactly what a new file escapes.
 *
 * `git ls-files` does not see an unstaged new file, so a census run before
 * `git add` measures nothing about a file just created. The count assertions
 * below are what turn that into a failure rather than a silent pass.
 */
function apiSources(): { file: string; code: string }[] {
  return execFileSync('git', ['ls-files', 'packages/api/src'], { cwd: REPO_ROOT, encoding: 'utf8' })
    .split('\n')
    .filter((f) => f.endsWith('.ts') && !f.includes('__tests__') && !f.endsWith('.test.ts'))
    .map((file) => ({ file, code: stripComments(readFileSync(path.join(REPO_ROOT, file), 'utf8')) }));
}

const SOURCES = apiSources();

// ===========================================================================
// The scanner's own controls
// ===========================================================================

describe('the census can see the tree it claims to scan', () => {
  it('reads a non-trivial number of files', () => {
    // Vacuity floor. An empty file list satisfies every "exactly one" and
    // "nothing else" assertion below by measuring nothing.
    expect(SOURCES.length).toBeGreaterThan(300);
    expect(SOURCES.map((s) => s.file)).toContain('packages/api/src/lib/gateway-client.ts');
  });

  it('removes comment text without moving a line', () => {
    const probe = 'a\n/* hidden\n   more */\nb // trailing\nc';
    const out = stripComments(probe);
    expect(out.split('\n')).toHaveLength(probe.split('\n').length);
    expect(out).not.toContain('hidden');
    expect(out).not.toContain('trailing');
    expect(out.split('\n')[3].trim()).toBe('b');
  });

  it('does not read a default out of a comment', () => {
    // The specific failure this guards: `model-resolver.ts` now EXPLAINS in
    // prose that it has no default, naming both the symbol and `alia-v1`. A
    // census that scanned raw source would count that explanation as a second
    // default and be permanently red.
    const resolver = SOURCES.find((s) => s.file.endsWith('internal/providers/lib/model-resolver.ts'));
    expect(resolver).toBeDefined();
    const raw = readFileSync(path.join(REPO_ROOT, 'packages/api/src/internal/providers/lib/model-resolver.ts'), 'utf8');
    expect(raw).toContain('getDefaultAliaModel');
    expect(resolver?.code).not.toContain('getDefaultAliaModel');
  });
});

// ===========================================================================
// Gate 1: exactly one owner
// ===========================================================================

/** Not `g`-flagged: a global regex's `.test()` is stateful and skips every other file. */
const DEFINITION = /function\s+getDefaultAliaModel\s*\(/;

describe('exactly one function answers "what model when the caller named none"', () => {
  it('is defined once in the whole API source, and in the product tree', () => {
    const definers = SOURCES.filter((s) => DEFINITION.test(s.code)).map((s) => s.file);
    // Exact, not a floor: `>= 1` is satisfied by the two-definition state this
    // file exists to prevent.
    expect(definers).toEqual(['packages/api/src/lib/gateway-client.ts']);
  });

  it('the routing tree ADR 0001 moves to Relay declares no default of its own', () => {
    // Stated separately from the count because it is a different property: even
    // one default is in the wrong place if it sits in the tree that migrates.
    const inProviderTree = SOURCES.filter(
      (s) => s.file.startsWith('packages/api/src/internal/providers/') && s.code.includes('getDefaultAliaModel'),
    );
    expect(inProviderTree.map((s) => s.file)).toEqual([]);

    // Positive control on that filter: the tree is non-empty and IS being read.
    expect(SOURCES.filter((s) => s.file.startsWith('packages/api/src/internal/providers/')).length)
      .toBeGreaterThan(10);
  });
});

// ===========================================================================
// Gate 2: the owner agrees with the catalogue, which derives it differently
// ===========================================================================

describe('the runtime default and the advertised default are the same model', () => {
  it('agrees with what GET /v1/models?category=general calls default_model', async () => {
    /**
     * Two independent derivations: this one is a constant, the catalogue's
     * minimises `creditMultiplier` over the general category
     * (`alia-models.ts` `getDefaultModelForCategory`). They agreed by accident
     * rather than by construction, and a count-based gate cannot see them drift
     * apart — which is the failure a user actually notices, because
     * `routes/v1/models.ts:84` publishes the catalogue's answer as
     * `default_model`.
     */
    const advertised = await getDefaultModelForCategory('general');
    expect(advertised).not.toBeNull();
    expect(getDefaultAliaModel()).toBe(advertised?.id);
  });

  it('the streaming route seeds its reported model from the owner, not a literal', () => {
    /**
     * `chat-completions.ts` arms an 80s timeout timer BEFORE
     * `buildChatRequestContext` returns, and that timer reports
     * `state.aliasModelId` to the client. The seed is therefore READ on a real
     * path, not merely overwritten — it used to restate `'alia-v1'`, so a
     * request that timed out during resolution was told it ran on a model the
     * default would never have selected.
     *
     * Asserted on the source because the behaviour needs a timeout to observe
     * and the suites that drive this handler mock the default away.
     */
    const route = SOURCES.find((s) => s.file.endsWith('routes/v1/chat-completions.ts'));
    expect(route).toBeDefined();
    expect(route?.code).toContain('aliasModelId: getDefaultAliaModel()');
    expect(route?.code).not.toMatch(/aliasModelId:\s*'alia-/);
  });

  it('the default is a real, chat-visible alias', () => {
    // A default nobody can select in the picker is a default users cannot
    // reproduce or reason about.
    const id = getDefaultAliaModel();
    expect(id).toMatch(/^alia-/);
    expect(SOURCES.find((s) => s.file.endsWith('internal/providers/lib/alia-models.ts'))?.code)
      .toContain(`id: '${id}'`);
  });
});

// ===========================================================================
// Gate 3: the frozen census of sites that still restate a literal
// ===========================================================================

/**
 * A literal that BECOMES the model when the caller named none: a fallback
 * operator, or a parameter default. Deliberately narrow — `x !== 'alia-lite'` is
 * a comparison and `suggestedModel = 'alia-v1'` is a classifier's output, and
 * folding either in would make this list noise nobody maintains.
 */
const RESTATED = /(?:\|\||\?\?)\s*'(alia-[a-z0-9-]+)'|:\s*string\s*=\s*'(alia-[a-z0-9-]+)'/g;

/**
 * Frozen exactly as it is today. Each entry says why it is not simply importing
 * the owner; the list may SHRINK freely and may only grow deliberately.
 */
const RESTATED_DEFAULTS: readonly { file: string; value: string; why: string }[] = [
  {
    file: 'packages/api/src/lib/credits-manager.ts',
    value: 'alia-v1-voice',
    why: 'Voice billing parameter default. Capability-scoped: the chat default cannot price a voice minute.',
  },
  {
    file: 'packages/api/src/lib/tools/agent-delegate.ts',
    value: 'alia-lite',
    why: "An agent's own allowedModels first, else the chat default. Agrees with the owner; should import it.",
  },
  {
    file: 'packages/api/src/lib/tools/agent-orchestrator.ts',
    value: 'alia-lite',
    why: 'Same shape as agent-delegate, same value, same fix available.',
  },
  {
    file: 'packages/api/src/lib/tools/delegate.ts',
    value: 'alia-v1',
    why: 'DELIBERATE and documented in place: names the alias the fallback engine already resolved to, so the tool stops reporting a model it did not run. Its comment states it is explicitly not the default.',
  },
  {
    file: 'packages/api/src/routes/v1/voice.ts',
    value: 'alia-v1-voice',
    why: 'Capability-scoped, and correct: a realtime voice session cannot run on the general chat default.',
  },
  {
    file: 'packages/api/src/routes/webhooks.ts',
    value: 'alia-lite',
    why: "A Telegram bot user's stored preference, else the chat default. Agrees with the owner; should import it.",
  },
];

describe('every site that restates an alias default is accounted for', () => {
  const observed = SOURCES.flatMap(({ file, code }) => {
    RESTATED.lastIndex = 0;
    const out: { file: string; value: string }[] = [];
    for (const m of code.matchAll(RESTATED)) out.push({ file, value: m[1] ?? m[2] });
    return out;
  });

  it('the pattern matches every spelling it claims to, so a small count is a fact', () => {
    // Positive controls, one per spelling. A pattern that misses one prints a
    // clean small number that reads like good news.
    const at = (suffix: string) => observed.filter((o) => o.file.endsWith(suffix)).map((o) => o.value);
    expect(at('lib/tools/delegate.ts')).toContain('alia-v1'); // `||` with a space
    expect(at('lib/tools/agent-delegate.ts')).toContain('alia-lite'); // `||` after `?.[0]`
    expect(at('lib/credits-manager.ts')).toContain('alia-v1-voice'); // parameter default
    // 8 -> 7 because `/v1/responses` stopped restating a default, not because
    // the scanner got weaker. A floor that a gate's own work erodes ends at
    // `>= 0`, so it moves by exactly the number of restatements deleted and the
    // exact-equality check below is what actually holds the line.
    expect(observed.length).toBeGreaterThanOrEqual(7);
  });

  it('is exactly the frozen list, in both directions', () => {
    // Both directions: a NEW restated default fails, and so does removing one
    // without deleting its line here. Deduplicated by file+value because two
    // call sites in one file with one value are one fact about that file.
    const key = (o: { file: string; value: string }) => `${o.file} -> ${o.value}`;
    expect([...new Set(observed.map(key))].sort()).toEqual([...new Set(RESTATED_DEFAULTS.map(key))].sort());
  });

  it('the frozen list is as long as it says, so it cannot grow a line at a time', () => {
    expect(RESTATED_DEFAULTS).toHaveLength(6);
    expect(new Set(RESTATED_DEFAULTS.map((r) => r.file)).size).toBe(6);
    for (const entry of RESTATED_DEFAULTS) expect(entry.why.length).toBeGreaterThan(40);
  });

  it('no entry disagrees with the owner on the general chat path', () => {
    // This test used to assert the OPPOSITE: it named `/v1/responses` as a live
    // divergence, escalated rather than decided, because reconciling it changes
    // what users are billed. The decision was taken, so the assertion inverts
    // with it rather than being deleted — a census that merely stopped
    // mentioning the defect would look identical to one that never saw it.
    //
    // Every remaining entry is capability-scoped (a voice minute cannot be
    // priced by the chat default) or deliberate and documented in place. None
    // is a second answer to "what does the general chat path default to".
    expect(RESTATED_DEFAULTS.find((r) => r.file.endsWith('routes/v1/responses.ts'))).toBeUndefined();

    // And the route now restates nothing at all, so there is no value left to
    // agree or disagree with the owner. Asserted on the source, because
    // "absent" is the whole claim.
    const responses = SOURCES.find((s) => s.file.endsWith('routes/v1/responses.ts'));
    expect(responses).toBeDefined();
    expect(responses?.code).toContain('model: body.model,');
    expect(responses?.code).not.toMatch(/model:\s*body\.model\s*\|\|/);

    // The general chat path has exactly one owner, and it is reachable.
    expect(getDefaultAliaModel()).toMatch(/^alia-/);
  });
});
