import { describe, expect, it } from 'vitest';
import {
  clarificationSpeaker,
  roomSelectionData,
  validateRoomDecision,
  type RoomSelectionInput,
} from '../decision.js';

const input: RoomSelectionInput = {
  userId: 'u',
  conversationId: 'room',
  triggerId: 'p',
  lastSpeakerId: null,
  depth: 0,
  roster: [
    {
      info: { id: 's', name: 'Salella', handle: 'salella', color: null, character: null },
      description: 'Marketing',
    },
    {
      info: { id: 'e', name: 'Eusebio', handle: 'eusebio', color: null, character: null },
      description: 'Research',
    },
  ],
  rows: [
    {
      id: 'p',
      clientMessageId: 'p',
      role: 'user',
      content: 'Hola! Eusebio que puedes hacer?',
      agentName: null,
    },
  ],
};

describe('room decision boundary', () => {
  it('validates available roster IDs and quiet completion', () => {
    expect(
      validateRoomDecision({ action: 'speak', agentId: 'e', reason: 'directed' }, input).agentId,
    ).toBe('e');
    expect(
      validateRoomDecision({ action: 'idle', agentId: null, reason: 'complete' }, input).action,
    ).toBe('idle');
    expect(() =>
      validateRoomDecision({ action: 'speak', agentId: 'outside', reason: 'directed' }, input),
    ).toThrow('non-member');
    expect(() =>
      validateRoomDecision({ action: 'idle', agentId: 's', reason: 'complete' }, input),
    ).toThrow();
  });

  it('knows an unavailable addressee but cannot run it', () => {
    const unavailable = {
      ...input,
      roster: input.roster.map((m) => ({ ...m, available: m.info.id !== 'e' })),
    };
    expect(
      validateRoomDecision(
        { action: 'unavailable', agentId: 'e', reason: 'unavailable' },
        unavailable,
      ).action,
    ).toBe('unavailable');
    expect(() =>
      validateRoomDecision({ action: 'speak', agentId: 'e', reason: 'directed' }, unavailable),
    ).toThrow('unavailable');
  });

  it('enforces real handoff depth and prevents consecutive speakers', () => {
    const next = { ...input, lastSpeakerId: 's', depth: 3 };
    expect(() =>
      validateRoomDecision({ action: 'speak', agentId: 'e', reason: 'handoff' }, next),
    ).toThrow('handoff');
    expect(() =>
      validateRoomDecision({ action: 'speak', agentId: 's', reason: 'contribution' }, next),
    ).toThrow('twice');
    expect(() =>
      validateRoomDecision({ action: 'speak', agentId: 'e', reason: 'handoff' }, input),
    ).toThrow('handoff');
  });

  it('clarifies through the most recent available interlocutor, otherwise the first available member', () => {
    const previous = {
      ...input,
      rows: [
        {
          id: 'old',
          clientMessageId: 'old',
          role: 'assistant',
          content: 'Hi',
          agentId: 'e',
          agentName: 'Eusebio',
        },
        ...input.rows,
      ],
    };
    expect(clarificationSpeaker(previous)).toBe('e');
    expect(clarificationSpeaker(input)).toBe('s');
    expect(() =>
      validateRoomDecision({ action: 'clarify', agentId: 's', reason: 'ambiguous' }, previous),
    ).toThrow('clarification');
  });

  it('serializes only public roster fields, exact trigger and bounded attributed observations', () => {
    const many = Array.from({ length: 60 }, (_, i) => ({
      id: `extra-${i}`,
      clientMessageId: null,
      role: 'assistant',
      content: 'x',
      agentId: 's',
      agentName: 'Salella',
    }));
    const serialized = roomSelectionData({
      ...input,
      rows: [...many, ...input.rows, ...many],
      roster: input.roster.map((m) => ({ ...m, oxyTaskId: 'AUTHORITY_SECRET' })),
      space: { name: 'Marketing', instructions: 'Prepare a campaign' },
    });
    const data = JSON.parse(serialized);
    expect(data.messages).toHaveLength(49);
    expect(data.messages[24].content).toBe('Hola! Eusebio que puedes hacer?');
    expect(data.space.name).toBe('Marketing');
    expect(serialized).not.toContain('AUTHORITY_SECRET');
  });

  it('rejects oversized requests rather than deleting trailing exclusions or addressees', () => {
    expect(() =>
      roomSelectionData({
        ...input,
        rows: [{ ...input.rows[0]!, content: `${'x'.repeat(16000)} only Eusebio` }],
      }),
    ).toThrow('selection budget');
  });
});
