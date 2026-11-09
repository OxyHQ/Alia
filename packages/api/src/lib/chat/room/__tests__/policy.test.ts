import { describe, expect, it } from 'vitest';
import type { AgentInfo } from '../../../../domain/conversation.js';
import {
  type ChainState,
  MAX_MENTION_DEPTH,
  MAX_MENTIONS_PER_REPLY,
  MAX_REPLIES_PER_MESSAGE,
  MAX_TURNS_PER_MESSAGE,
  PASS_SENTINEL,
  ROOM_REPLIES_PER_WINDOW,
  createPassGate,
  firstRound,
  isPass,
  isSuperseded,
  parseMentions,
  planNext,
  roomPrompt,
  roomRateExceeded,
} from '../policy.js';

const info = (id: string, name: string, handle: string): AgentInfo => ({
  id,
  name,
  handle,
  color: null,
  character: null,
});

const nadia = info('a', 'Nadia Ruiz', 'nadia');
const bruno = info('b', 'Bruno', 'bruno.b');
const celia = info('c', 'Célia', 'celia');
const roster = [nadia, bruno, celia];

describe('parseMentions', () => {
  it('matches handle, full name and first name, ignoring case and accents', () => {
    expect(parseMentions('hey @NADIA', roster)).toEqual(['a']);
    expect(parseMentions('hey @Nadia Ruiz, listen', roster)).toEqual(['a']);
    expect(parseMentions('hey @nadiaruiz', roster)).toEqual(['a']);
    expect(parseMentions('@celia and @CÉLIA', roster)).toEqual(['c']);
    expect(parseMentions('@Célia?', roster)).toEqual(['c']);
    expect(parseMentions('@bruno.b please', roster)).toEqual(['b']);
  });

  it('keeps the order of appearance and each member once', () => {
    expect(parseMentions('@celia then @bruno then @celia', roster)).toEqual(['c', 'b']);
  });

  it('never returns the excluded speaker (self-mention)', () => {
    expect(parseMentions('I, @nadia, ask @bruno', roster, { exclude: 'a' })).toEqual(['b']);
  });

  it('ignores names that are not members and plain words', () => {
    expect(parseMentions('@zoe hi, nadia and bruno', roster)).toEqual([]);
    expect(parseMentions('write to me@nadia.com', roster)).toEqual([]);
  });

  it('does not match inside a longer word', () => {
    expect(parseMentions('@nadiaxyz', roster)).toEqual([]);
  });

  it('refuses an ambiguous first name instead of guessing', () => {
    const twins = [info('x', 'Ana Gil', 'anagil'), info('y', 'Ana Paz', 'anapaz')];
    expect(parseMentions('@ana', twins)).toEqual([]);
    expect(parseMentions('@ana paz', twins)).toEqual(['y']);
    expect(parseMentions('@anagil', twins)).toEqual(['x']);
  });
});

describe('firstRound', () => {
  it('asks every member in the group order when the person mentions nobody', () => {
    expect(firstRound('hello all', roster)).toEqual(['a', 'b', 'c']);
  });

  it('asks only the mentioned members, in the order mentioned', () => {
    expect(firstRound('@celia and @nadia, thoughts?', roster)).toEqual(['c', 'a']);
  });
});

const state = (over: Partial<ChainState> = {}): ChainState => ({
  pending: [],
  depth: 0,
  replies: 1,
  turns: 1,
  lastSpeakerId: 'a',
  ...over,
});

describe('planNext', () => {
  it('goes on with the members still pending, in order', () => {
    const next = planNext({
      roster,
      speakerId: 'a',
      reply: 'my take',
      state: state({ pending: ['b', 'c'] }),
    });
    expect(next).toEqual({ queue: ['b', 'c'], depth: 0, stop: null });
  });

  it('gives the floor to a mentioned member before the pending ones', () => {
    const next = planNext({
      roster,
      speakerId: 'a',
      reply: 'over to @celia',
      state: state({ pending: ['b', 'c'] }),
    });
    expect(next.queue).toEqual(['c', 'b']);
    expect(next.depth).toBe(1);
  });

  it('ignores self-mentions and non-members', () => {
    const next = planNext({
      roster,
      speakerId: 'a',
      reply: '@nadia and @zoe',
      state: state({ pending: [] }),
    });
    expect(next).toEqual({ queue: [], depth: 0, stop: null });
  });

  it('hands the floor to at most MAX_MENTIONS_PER_REPLY members', () => {
    const many = Array.from({ length: 6 }, (_, i) => info(`m${i}`, `M${i}x`, `m${i}x`));
    const next = planNext({
      roster: many,
      speakerId: 'm5',
      reply: many.map((m) => `@${m.handle}`).join(' '),
      state: state({ lastSpeakerId: 'm5' }),
    });
    expect(next.queue).toHaveLength(MAX_MENTIONS_PER_REPLY);
  });

  it('stops following mentions past MAX_MENTION_DEPTH, so a ping-pong ends', () => {
    const next = planNext({
      roster,
      speakerId: 'a',
      reply: '@bruno',
      state: state({ depth: MAX_MENTION_DEPTH }),
    });
    expect(next.queue).toEqual([]);
    expect(next.depth).toBe(MAX_MENTION_DEPTH);
  });

  it('never lets the member who spoke last speak again right away', () => {
    const next = planNext({
      roster,
      speakerId: 'a',
      reply: 'hi',
      state: state({ pending: ['a', 'b'], lastSpeakerId: 'a' }),
    });
    expect(next.queue).toEqual(['b']);
  });

  it('lets a member answer again once someone else spoke in between', () => {
    // b answered a's mention of b and mentions a back: a is not the last speaker, b is.
    const next = planNext({
      roster,
      speakerId: 'b',
      reply: 'back to @nadia',
      state: state({ lastSpeakerId: 'b', depth: 1 }),
    });
    expect(next.queue).toEqual(['a']);
  });

  it('a decline or failure hands the floor to nobody and keeps the others going', () => {
    const next = planNext({
      roster,
      speakerId: 'b',
      reply: null,
      state: state({ pending: ['c'], lastSpeakerId: 'a', replies: 1, turns: 2 }),
    });
    expect(next).toEqual({ queue: ['c'], depth: 0, stop: null });
  });

  it('stops at the reply cap and at the turn cap', () => {
    expect(
      planNext({
        roster,
        speakerId: 'a',
        reply: '@bruno',
        state: state({ replies: MAX_REPLIES_PER_MESSAGE, pending: ['b'] }),
      }),
    ).toEqual({ queue: [], depth: 0, stop: 'reply_cap' });
    expect(
      planNext({
        roster,
        speakerId: 'a',
        reply: null,
        state: state({ turns: MAX_TURNS_PER_MESSAGE, pending: ['b'] }),
      }),
    ).toEqual({ queue: [], depth: 0, stop: 'turn_cap' });
  });

  it('always terminates: simulated mutual mentions end within the caps', () => {
    let s = state({ pending: [], replies: 0, turns: 0, lastSpeakerId: null });
    let speaker = 'a';
    let steps = 0;
    for (;;) {
      steps += 1;
      const other = speaker === 'a' ? 'b' : 'a';
      s = { ...s, replies: s.replies + 1, turns: s.turns + 1, lastSpeakerId: speaker };
      const next = planNext({ roster, speakerId: speaker, reply: `@${other}`, state: s });
      if (next.queue.length === 0) break;
      s = { ...s, depth: next.depth, pending: next.queue.slice(1) };
      speaker = next.queue[0]!;
      expect(steps).toBeLessThan(MAX_REPLIES_PER_MESSAGE + 2);
    }
    expect(steps).toBeLessThanOrEqual(MAX_MENTION_DEPTH + 1);
  });
});

describe('supersede and rate rules', () => {
  it('a chain is current only while its trigger is the latest person message', () => {
    expect(isSuperseded('p1', 'p1')).toBe(false);
    expect(isSuperseded('p1', 'p2')).toBe(true);
    expect(isSuperseded('p1', null)).toBe(true);
  });

  it('a room is limited per window', () => {
    expect(roomRateExceeded(ROOM_REPLIES_PER_WINDOW - 1)).toBe(false);
    expect(roomRateExceeded(ROOM_REPLIES_PER_WINDOW)).toBe(true);
  });
});

describe('the decline sentinel', () => {
  it('recognises exactly the whole reply', () => {
    expect(isPass(PASS_SENTINEL)).toBe(true);
    expect(isPass('  [PASS].  ')).toBe(true);
    expect(isPass('[pass] but I do have a thought')).toBe(false);
    expect(isPass('pass')).toBe(false);
  });

  it('holds back a sentinel and releases anything else at once, in order', () => {
    const shown: string[] = [];
    const declined = createPassGate((text) => shown.push(text));
    declined.push('[pa');
    declined.push('ss]');
    expect(declined.finish()).toBe(true);
    expect(shown).toEqual([]);

    const spoken = createPassGate((text) => shown.push(text));
    spoken.push('[');
    spoken.push('x] hello');
    spoken.push(' world');
    expect(spoken.finish()).toBe(false);
    expect(shown).toEqual(['[x] hello', ' world']);

    const plain = createPassGate((text) => shown.push(text));
    plain.push('Sure');
    expect(shown.at(-1)).toBe('Sure');
    expect(plain.finish()).toBe(false);
  });
});

describe('roomPrompt', () => {
  it('frames the group, names the others and offers the sentinel only to a handed-over turn', () => {
    const asked = roomPrompt({
      self: nadia,
      roster,
      personText: 'what now?',
      since: [],
      handedBy: null,
    });
    expect(asked.startsWith('what now?')).toBe(true);
    expect(asked).toContain('group chat');
    expect(asked).toContain('Bruno (@bruno.b)');
    expect(asked).not.toContain('Nadia Ruiz (@nadia)');
    expect(asked).toContain('@name');
    expect(asked).not.toContain(PASS_SENTINEL);

    const handed = roomPrompt({
      self: nadia,
      roster,
      personText: 'what now?',
      since: [{ name: 'Bruno', content: 'ask @nadia' }],
      handedBy: 'Bruno',
    });
    expect(handed).toContain('Bruno addressed you');
    expect(handed).toContain(PASS_SENTINEL);
    expect(handed).toContain('Bruno: ask @nadia');
  });
});
