/**
 * The default chat model has ONE owner — epic #139.
 *
 * Two functions called `getDefaultRoutingProfile` existed, in
 * `lib/gateway-client.ts` (`kaana-lite`) and
 * `internal/providers/lib/model-resolver.ts` (`kaana-v1`), disagreeing about what
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
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { getDefaultRoutingProfile, getDefaultModelForCategory } from '../gateway-client.js';
import { routingPolicyIdFor, routingProfileFor } from '../product-modes.js';

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
 * Include untracked worktree files and exclude deleted index entries so this
 * gate also measures a rename before `git add`.
 */
function apiSources(): { file: string; code: string }[] {
  return execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '--', 'packages/api/src'], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
  })
    .split('\n')
    .filter((f) => f.endsWith('.ts') && !f.includes('__tests__') && !f.endsWith('.test.ts'))
    .filter((file) => existsSync(path.join(REPO_ROOT, file)))
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
    const raw = '/* getDefaultRoutingProfile() returns kaana-v1 */\nexport const harmless = true;';
    expect(stripComments(raw)).not.toContain('getDefaultRoutingProfile');
  });
});

// ===========================================================================
// Gate 1: exactly one owner
// ===========================================================================

/** Not `g`-flagged: a global regex's `.test()` is stateful and skips every other file. */
const DEFINITION = /function\s+getDefaultRoutingProfile\s*\(/;

describe('exactly one function answers "what model when the caller named none"', () => {
  it('is defined once in the whole API source, and in the product tree', () => {
    const definers = SOURCES.filter((s) => DEFINITION.test(s.code)).map((s) => s.file);
    // Exact, not a floor: `>= 1` is satisfied by the two-definition state this
    // file exists to prevent.
    expect(definers).toEqual(['packages/api/src/lib/gateway-client.ts']);
  });

  it('the routing tree ADR 0001 moves to Kaana declares no default of its own', () => {
    // Stated separately from the count because it is a different property: even
    // one default is in the wrong place if it sits in the tree that migrates.
    const inProviderTree = SOURCES.filter(
      (s) => s.file.startsWith('packages/api/src/internal/providers/') && s.code.includes('getDefaultRoutingProfile'),
    );
    expect(inProviderTree.map((s) => s.file)).toEqual([]);

    // Positive control on that filter: the tree is non-empty and IS being read.
    expect(SOURCES.filter((s) => s.file.startsWith('packages/api/src/internal/providers/')).length)
      .toBeGreaterThan(5);
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
     * (`routing-profile-catalogue.ts` `getDefaultModelForCategory`). They agreed by accident
     * rather than by construction, and a count-based gate cannot see them drift
     * apart — which is the failure a user actually notices, because
     * `routes/v1/models.ts:84` publishes the catalogue's answer as
     * `default_model`.
     */
    const advertised = await getDefaultModelForCategory('general');
    expect(advertised).not.toBeNull();
    expect(getDefaultRoutingProfile()).toBe(advertised?.id);
  });

  it('the streaming route seeds its reported model from the owner, not a literal', () => {
    /**
     * `chat-completions.ts` arms an 80s timeout timer BEFORE
     * `buildChatRequestContext` returns, and that timer reports
     * `state.routingProfileId` to the client. The seed is therefore READ on a real
     * path, not merely overwritten — it used to restate `'kaana-v1'`, so a
     * request that timed out during resolution was told it ran on a model the
     * default would never have selected.
     *
     * Asserted on the source because the behaviour needs a timeout to observe
     * and the suites that drive this handler mock the default away.
     */
    const route = SOURCES.find((s) => s.file.endsWith('routes/v1/chat-completions.ts'));
    expect(route).toBeDefined();
    expect(route?.code).toContain('routingProfileId: getDefaultRoutingProfile()');
    expect(route?.code).not.toMatch(/routingProfileId:\s*'alia-/);
  });

  it('the default is a real, chat-visible Kaana routing profile', () => {
    // A default nobody can select in the picker is a default users cannot
    // reproduce or reason about.
    const id = getDefaultRoutingProfile();
    expect(id).toMatch(/^kaana-/);
    expect(SOURCES.find((s) => s.file.endsWith('internal/providers/lib/routing-profile-catalogue.ts'))?.code)
      .toContain(`id: '${id}'`);
  });
});

// ===========================================================================
// Gate 3: the frozen census of sites that still restate a literal
// ===========================================================================

/**
 * A literal that BECOMES the model when the caller named none: a fallback
 * operator, or a parameter default. Deliberately narrow — `x !== 'kaana-lite'` is
 * a comparison and `suggestedModel = 'kaana-v1'` is a classifier's output, and
 * folding either in would make this list noise nobody maintains.
 */
const RESTATED = /(?:\|\||\?\?)\s*'(kaana-[a-z0-9-]+)'|:\s*string\s*=\s*'(kaana-[a-z0-9-]+)'/g;

/**
 * Frozen exactly as it is today. Each entry says why it is not simply importing
 * the owner; the list may SHRINK freely and may only grow deliberately.
 */
const RESTATED_DEFAULTS: readonly { file: string; value: string; why: string }[] = [
  {
    file: 'packages/api/src/lib/credits-manager.ts',
    value: 'kaana-v1-voice',
    why: 'Voice billing parameter default. Capability-scoped: the chat default cannot price a voice minute.',
  },
  {
    file: 'packages/api/src/lib/tools/agent-turn.ts',
    value: 'kaana-lite',
    why: "An agent's own allowedModels first, else the chat default. Agrees with the owner; should import it. Was in `agent-delegate.ts` until the nested turn became one shared runner.",
  },
  {
    file: 'packages/api/src/lib/tools/delegate.ts',
    value: 'kaana-v1',
    why: 'DELIBERATE and documented in place: names the alias the fallback engine already resolved to, so the tool stops reporting a model it did not run. Its comment states it is explicitly not the default.',
  },
];

describe('every site that restates a Kaana routing-profile default is accounted for', () => {
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
    expect(at('lib/tools/delegate.ts')).toContain('kaana-v1'); // `||` with a space
    expect(at('lib/tools/agent-turn.ts')).toContain('kaana-lite'); // `||` after `[0]`
    expect(at('lib/credits-manager.ts')).toContain('kaana-v1-voice'); // parameter default
    // 8 -> 7 because `/v1/responses` stopped restating a default, then 7 -> 6
    // because `routes/webhooks.ts` did: #244 made a bot's stored preference a
    // canonical profile, so that site reads `getDefaultRoutingProfile()` instead of
    // naming a second literal. Neither
    // is the scanner getting weaker. A floor that a gate's own work erodes ends
    // at `>= 0`, so it moves by exactly the number of restatements deleted and
    // the exact-equality check below is what actually holds the line.
    // 6 -> 5: `lib/tools/agent-orchestrator.ts` is DELETED. It was registered
    // into `tools/registry.ts` and reached a model through nothing, and both it
    // and the registry went with the five tool assemblers becoming one.
    // 5 -> 4: `/v1/voice` now returns an explicit hosted-capability error and
    // therefore no longer chooses a routing profile locally.
    expect(observed.length).toBeGreaterThanOrEqual(4);
  });

  it('is exactly the frozen list, in both directions', () => {
    // Both directions: a NEW restated default fails, and so does removing one
    // without deleting its line here. Deduplicated by file+value because two
    // call sites in one file with one value are one fact about that file.
    const key = (o: { file: string; value: string }) => `${o.file} -> ${o.value}`;
    expect([...new Set(observed.map(key))].sort()).toEqual([...new Set(RESTATED_DEFAULTS.map(key))].sort());
  });

  it('the frozen list is as long as it says, so it cannot grow a line at a time', () => {
    expect(RESTATED_DEFAULTS).toHaveLength(3);
    expect(new Set(RESTATED_DEFAULTS.map((r) => r.file)).size).toBe(3);
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
    expect(getDefaultRoutingProfile()).toMatch(/^kaana-/);
  });

  /**
   * The files whose restated default answers a question the chat default cannot.
   *
   * Named individually, because "capability-scoped" is a judgement and a
   * predicate that inferred it — from the value, or from the path — would
   * quietly absorb the next general-path divergence that happened to look like
   * one. Each entry's reasoning is already written in its `why` above and is
   * deliberately not copied here, where it would drift.
   *
   *  - `credits-manager.ts` prices a voice minute, which the general chat
   *    default cannot serve.
   *  - `lib/tools/delegate.ts` names the alias the fallback engine ALREADY
   *    resolved to, so the tool stops reporting a model it did not run on. Its
   *    own comment states it is explicitly not the default.
   */
  const CAPABILITY_SCOPED: readonly string[] = [
    'packages/api/src/lib/credits-manager.ts',
    'packages/api/src/lib/tools/delegate.ts',
  ];

  it('no general chat-path restatement disagrees with the owner, whichever file it is in', () => {
    /**
     * The CLASS, where the test above asserts the INSTANCE.
     *
     * That one pins `/v1/responses`: the census has no entry for it and its
     * source restates nothing. Both are true and neither says anything about a
     * divergence appearing somewhere else — and a new one arrives complete with
     * its own census entry, because the exact-equality check above forces the
     * author to add one. At that point every assertion in this file passes
     * except this one.
     *
     * Measured, not argued: changing `agent-delegate.ts` to `|| 'kaana-v1'` and
     * updating its census entry to match leaves the whole suite green apart
     * from this test, which names the file and both values.
     */
    const generalChatPath = RESTATED_DEFAULTS.filter((r) => !CAPABILITY_SCOPED.includes(r.file));

    // The exemption list needs its own exact count, or it erodes one defensible
    // entry at a time until every restatement is "capability-scoped" and this
    // check is vacuous. It may shrink; growing it is a reviewed line.
    expect(CAPABILITY_SCOPED).toHaveLength(2);
    // And every exempted file must still BE in the census. A renamed or deleted
    // entry would otherwise leave a name here that excuses nothing, which is how
    // an exemption list stops describing the code it exempts.
    for (const file of CAPABILITY_SCOPED) {
      expect(RESTATED_DEFAULTS.map((r) => r.file), `${file} is exempted but not in the census`).toContain(file);
    }

    // The floor: if the filter ever empties, "none disagrees" is a fact about
    // the exemption list rather than about the defaults. 3 -> 2 with #244:
    // `routes/webhooks.ts` was one of the three and now restates nothing, so
    // the filter has one fewer general-path entry to check rather than one
    // fewer reason to check.
    // 2 -> 1 with `agent-orchestrator.ts`, which was the other one.
    expect(generalChatPath).toHaveLength(1);
    for (const entry of generalChatPath) {
      expect(entry.value, `${entry.file} disagrees with the owner`).toBe(getDefaultRoutingProfile());
    }
  });
});

// ===========================================================================
// Gate 4: the APP's default and the server's default are different models
// ===========================================================================

/**
 * The chat app ships its own default, and it is not this one.
 *
 * `packages/app/lib/config.ts` `DEFAULT_MODEL_ID` is what the picker stores for
 * a device that has never chosen, and `getDefaultRoutingProfile()` is what a request
 * carrying no `model` at all resolves to. Both answer "what runs when the user
 * expressed no preference", from opposite ends, and **they name different
 * models**: `profile:v1` against `kaana-lite`, which is `profile:lite`.
 *
 * That divergence is not a bug to fix here — which of the two the product wants
 * is a product decision, and reconciling it moves what every un-chosen request
 * costs. It is a TRAP, and the trap is specific: the picker now offers an
 * "Automatic" row whose whole meaning is "send no model and let the server
 * decide". Making that row the app's DEFAULT — the obvious next step, and what
 * the reference design does — would move every user who never chose from
 * Balanced to Fast, silently, with no migration and nothing in the UI to show
 * it happened.
 *
 * So it is frozen rather than described. Change either end and this fails, and
 * whoever changed it reads the paragraph above before deciding what to do about
 * it. A comment cannot do that.
 *
 * Deliberately NOT asserted as equality-once-fixed: writing the gate as
 * `toBe(appDefault)` today would be a red suite describing a decision nobody
 * has taken.
 */
const APP_CONFIG = 'packages/app/lib/config.ts';

/** The literal fallback, not the env override: `?? 'profile:v1'`. */
const APP_DEFAULT = /DEFAULT_MODEL_ID\s*=\s*process\.env\.[A-Z_]+\s*\?\?\s*'([^']+)'/;

describe('the app default and the server default are a known, frozen divergence', () => {
  const source = readFileSync(path.join(REPO_ROOT, APP_CONFIG), 'utf8');
  const matched = stripComments(source).match(APP_DEFAULT);

  it('reads the app constant it claims to read', () => {
    /**
     * The control this gate cannot do without. "They differ" is satisfied by
     * `undefined !== 'profile:lite'`, so a renamed constant, a moved file or a
     * changed spelling would make the divergence assertion below pass while
     * measuring nothing at all — the exact shape of a check that stops working
     * and keeps reporting good news.
     */
    expect(matched, `${APP_CONFIG} no longer declares DEFAULT_MODEL_ID in the expected shape`)
      .not.toBeNull();
    expect(matched?.[1]).toMatch(/^profile:/);
  });

  it('still names two different models, so the trap above is still live', () => {
    const appDefault = matched?.[1];
    const serverDefault = routingPolicyIdFor(getDefaultRoutingProfile());

    // Both sides resolved to the SAME vocabulary before comparing. Comparing
    // `profile:v1` against `kaana-lite` would "differ" even after somebody
    // reconciled them, which is a gate that can never go green.
    expect(serverDefault, 'the server default resolves to no routing profile').not.toBeNull();
    expect(appDefault).not.toBe(serverDefault);

    // Frozen values, so a change on EITHER side lands here rather than
    // silently redefining what an un-chosen request runs on.
    expect(appDefault).toBe('profile:v1');
    expect(serverDefault).toBe('profile:lite');
  });

  it('the app default is a profile the product actually offers', () => {
    // Because the picker falls back to it, an unoffered value would leave a
    // device that never chose pointing at a row that is not in the menu.
    const offered = SOURCES.find((s) => s.file.endsWith('lib/product-modes.ts'))?.code;
    expect(offered).toBeDefined();
    const appProfile = matched?.[1] === undefined ? null : routingProfileFor(matched[1]);
    expect(appProfile).not.toBeNull();
    expect(offered).toContain(`'${appProfile}'`);
  });
});
