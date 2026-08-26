import { describe, expect, it } from 'vitest';
import { USERNAME_MAX_LENGTH, USERNAME_MIN_LENGTH, isValidUsername } from '@oxyhq/contracts';

import {
  applyBotUsernameSuffix,
  fallbackAgentUsername,
  suggestAgentUsername,
} from '../agent-identity.js';

/**
 * The username an agent is OFFERED, and who decides whether it is one.
 *
 * This used to be the eighth copy of Oxy's username rules, and it re-encoded a
 * SUBSET — which is worse than encoding none, because the gaps are invisible.
 * It knew about empty slugs and leading digits. It did not know there is a
 * MINIMUM, so an agent called "Al" proposed `al` and collected a 400 from a
 * server it had never asked. And it invented a rule nobody has: leading digits
 * are fine, so "1984" was handed a random fallback for a name Oxy would have
 * taken.
 *
 * Every expectation below is checked against `@oxyhq/contracts` itself rather
 * than against constants restated here. A test that hard-coded "3" would keep
 * passing the day the schema moved, which is the failure this whole change
 * exists to end.
 */

describe('the username an agent is offered', () => {
  it('is judged by the schema, not by this suite', () => {
    // The guard: if the contract stopped exporting these, the assertions below
    // would be comparing against `undefined` and would pass over nothing.
    expect(USERNAME_MIN_LENGTH).toBeGreaterThan(0);
    expect(USERNAME_MAX_LENGTH).toBeGreaterThan(USERNAME_MIN_LENGTH);
    expect(isValidUsername('alx')).toBe(true);
  });

  it.each([
    ['Community Maestro', 'community-maestro'],
    ['Nate.  Isern!', 'nate-isern'],
    // The rule this file used to invent. Oxy takes it; nothing here may refuse it.
    ['1984', '1984'],
  ])('shapes %j into a name the schema accepts', (name, expected) => {
    const proposed = suggestAgentUsername(name);

    expect(proposed).toBe(expected);
    expect(isValidUsername(proposed ?? '')).toBe(true);
  });

  it('offers nothing for a name too short to be a username', () => {
    // The case that failed in production: two letters, proposed anyway, refused
    // by a server that was never asked.
    expect('Al'.length).toBeLessThan(USERNAME_MIN_LENGTH);
    expect(suggestAgentUsername('Al')).toBeNull();
  });

  it('offers nothing for a name that shapes into nothing at all', () => {
    expect(suggestAgentUsername('!!! ...')).toBeNull();
    expect(suggestAgentUsername('')).toBeNull();
  });

  it('cuts at the schema’s maximum without ending on a separator', () => {
    // Truncation is where a shaped name most easily becomes invalid: the cut
    // lands on a hyphen and the schema refuses a trailing separator.
    const long = suggestAgentUsername(`${'ab '.repeat(40)}tail`);

    expect(long).not.toBeNull();
    expect((long ?? '').length).toBeLessThanOrEqual(USERNAME_MAX_LENGTH);
    expect(isValidUsername(long ?? '')).toBe(true);
  });

  it('never proposes something the schema would refuse, over a wide sweep', () => {
    // The property, rather than a list of examples: whatever comes back is
    // either null or valid. A shaping step that produced a repeated separator
    // or a leading hyphen would land here.
    const names = [
      'A', 'Al', 'Ana', 'Zoë Ruiz', '  spaced  out  ', '---', '_x_', 'a--b',
      '日本語', 'Ünïcödé Nâme', '1984', '007 Bond', 'x'.repeat(200),
      'Dr. Strange, PhD', 'foo_bar-baz', 'ends-with-',
    ];

    for (const name of names) {
      const proposed = suggestAgentUsername(name);
      if (proposed !== null) {
        expect(isValidUsername(proposed), `${name} -> ${proposed}`).toBe(true);
      }
    }
  });

  it('has a fallback the schema accepts, every time', () => {
    // A fallback the schema refuses would turn "no name to propose" into
    // "cannot create an agent". Asserted rather than read: the previous one
    // could return `agent-` when `Math.random()` came back small enough.
    for (let attempt = 0; attempt < 200; attempt++) {
      const fallback = fallbackAgentUsername();
      expect(isValidUsername(fallback), fallback).toBe(true);
    }
  });

  it('gives a different fallback each time, so two agents do not collide', () => {
    const seen = new Set(Array.from({ length: 50 }, () => fallbackAgentUsername()));

    expect(seen.size).toBe(50);
  });
});

/**
 * The label a bot's handle wears, as a rule rather than as a path.
 *
 * Oxy holds `kind: 'bot'` to everything the base policy demanded PLUS a handle
 * ending in `bot`, and Alia is the only thing minting bot accounts anywhere in
 * the ecosystem. What each door sends is asserted at the door — the chat tool's
 * in `tools/__tests__/agent-create.test.ts`, the create screen's in the app —
 * because a proposal is not a handle. This file holds the rule those doors
 * apply, and the cases where appending blindly would be wrong.
 *
 * Checked against `@oxyhq/contracts` for everything except the label itself,
 * which the installed version does not publish yet. When it does, this function
 * is replaced by its `applyBotUsernameSuffix` and these cases carry over: they
 * describe the rule, not Alia's stand-in for it.
 */
describe('the label a bot handle ends in', () => {
  it('turns anything the generator offers into a handle the schema still accepts', () => {
    // The property over the whole shaping surface: a label that pushed a name
    // past the maximum, or landed after a truncation that left a separator,
    // would produce a handle Oxy refuses for a reason that has nothing to do
    // with bots.
    const names = [
      'A', 'Al', 'Ana', 'Zoë Ruiz', '  spaced  out  ', '---', '_x_', 'a--b',
      '日本語', 'Ünïcödé Nâme', '1984', '007 Bond', 'x'.repeat(200),
      'Dr. Strange, PhD', 'foo_bar-baz', 'ends-with-', 'Garden Helper',
      `${'ab '.repeat(40)}tail`,
    ];

    for (const name of names) {
      const handle = applyBotUsernameSuffix(suggestAgentUsername(name) ?? fallbackAgentUsername());

      expect(isValidUsername(handle), `${name} -> ${handle}`).toBe(true);
      expect(handle.length, handle).toBeLessThanOrEqual(USERNAME_MAX_LENGTH);
      expect(handle.toLowerCase().endsWith('bot'), handle).toBe(true);
    }
  });

  it('cuts to leave room for the label rather than overflowing the maximum', () => {
    const full = applyBotUsernameSuffix('a'.repeat(USERNAME_MAX_LENGTH));

    expect(full.length).toBe(USERNAME_MAX_LENGTH);
    expect(isValidUsername(full)).toBe(true);
    expect(full.endsWith('bot')).toBe(true);
  });

  it('leaves a handle that already carries the label alone, whatever its case', () => {
    // `mybotbot` is what an unconditional append produces, and Oxy would take
    // it — so nothing but this says the append is conditional. The folded cases
    // matter because Oxy's uniqueness index folds too: a case-sensitive test
    // would accept `mybot` and relabel `MyBot`, two names the index considers
    // one.
    expect(applyBotUsernameSuffix('mybot')).toBe('mybot');
    expect(applyBotUsernameSuffix('MyBot')).toBe('MyBot');
    expect(applyBotUsernameSuffix('MYBOT')).toBe('MYBOT');
  });

  it('labels a name that merely contains the word, because the rule is about the end', () => {
    // The label is not a reserved word: `botanist` is a name anybody may hold,
    // and as a BOT's handle it still has to end in the label.
    expect(applyBotUsernameSuffix('botanist')).toBe('botanistbot');
    expect(applyBotUsernameSuffix('robotics')).toBe('roboticsbot');
  });

  it('appends and never inserts, leaving the separator to whoever chose the name', () => {
    // All three conform at Oxy — `-` and `_` are equal separators there — so
    // this is a statement about what Alia produces, not about what is legal.
    expect(applyBotUsernameSuffix('garden-helper')).toBe('garden-helperbot');
    expect(applyBotUsernameSuffix('garden-helper-')).toBe('garden-helper-bot');
    expect(applyBotUsernameSuffix('garden_helper_')).toBe('garden_helper_bot');
  });
});
