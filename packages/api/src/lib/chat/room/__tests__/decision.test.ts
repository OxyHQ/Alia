import { describe, expect, it } from 'vitest';
import {
  clarificationSpeaker,
  roomChoiceDecision,
  roomChoiceSchema,
  roomDecisionChoices,
  roomSelectionData,
  validateRoomDecision,
  type RoomSelectionInput,
} from '../decision.js';
import { MAX_MENTION_DEPTH } from '../policy.js';

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

describe('complete legal choices for ordinary room selection', () => {
  it('offers exactly the existing validator authority across reach, prior speaker and handoff bounds', () => {
    for (const unavailable of [[], ['s'], ['e'], ['s', 'e']]) {
      for (const lastSpeakerId of [null, 's', 'e']) {
        for (const depth of [0, MAX_MENTION_DEPTH]) {
          const context = {
            ...input,
            lastSpeakerId,
            depth,
            roster: input.roster.map((member) => ({
              ...member,
              available: !unavailable.includes(member.info.id),
            })),
          };
          const choices = roomDecisionChoices(context);
          const offered = choices.map(({ id, decision }) => {
            expect(roomChoiceSchema(choices).safeParse({ choice: id }).success).toBe(true);
            expect(roomChoiceDecision({ choice: id }, choices)).toBe(decision);
            expect(Object.isFrozen(decision)).toBe(true);
            return JSON.stringify(validateRoomDecision(decision, context));
          });
          const legal: string[] = [];
          for (const action of ['speak', 'clarify', 'idle', 'unavailable'])
            for (const agentId of [null, 's', 'e', 'outsider'])
              for (const reason of [
                'directed',
                'contribution',
                'handoff',
                'complete',
                'ambiguous',
                'unavailable',
              ]) {
                try {
                  legal.push(
                    JSON.stringify(validateRoomDecision({ action, agentId, reason }, context)),
                  );
                } catch {
                  /* This candidate is outside the existing authority boundary. */
                }
              }
          expect(offered.sort()).toEqual(legal.sort());
        }
      }
    }
  });

  it('keeps idle available without a roster and the stable clarifier even when it was the last speaker', () => {
    expect(roomDecisionChoices({ ...input, roster: [] })).toEqual([
      { id: 'idle', decision: { action: 'idle', agentId: null, reason: 'complete' } },
    ]);
    const choices = roomDecisionChoices({ ...input, lastSpeakerId: 's' });
    expect(choices.some(({ id }) => id === 'clarify:s')).toBe(true);
    expect(
      choices.some(({ decision }) => decision.action === 'speak' && decision.agentId === 's'),
    ).toBe(false);
  });

  it('does not let generated fields change the server choice, and forbids contradictory flat output', () => {
    const choices = roomDecisionChoices(input);
    expect(
      roomChoiceDecision({ choice: 'speak:directed:e', agentId: 's', reason: 'handoff' }, choices),
    ).toEqual({ action: 'speak', agentId: 'e', reason: 'directed' });
    expect(() =>
      roomChoiceDecision({ action: 'clarify', agentId: 's', reason: 'directed' }, choices),
    ).toThrow();
    expect(() => roomChoiceDecision({ choice: 'speak:handoff:e' }, choices)).toThrow();
    const data = JSON.parse(roomSelectionData(input, choices));
    expect(data.allowedChoices).toEqual(choices.map(({ id, decision }) => ({ id, ...decision })));
    expect(data.messages[0].content).toBe(input.rows[0]?.content);
  });
});

describe('room decision boundary', () => {
  it('identifies a reacted-to message by the same stable ID in the trigger and attributed transcript', () => {
    const data = JSON.parse(
      roomSelectionData({
        ...input,
        triggerId: 'reaction-event',
        trigger: {
          kind: 'reaction',
          eventId: 'reaction-event',
          messageId: 'client-answer',
          actorId: 'e',
          senderId: 'u',
          emoji: '❤️',
          reactions: ['❤️'],
        },
        rows: [
          ...input.rows,
          {
            id: 'new-database-row',
            clientMessageId: 'client-answer',
            role: 'assistant',
            content: 'My answer',
            agentId: 'e',
            agentName: 'Eusebio',
          },
        ],
      }),
    );
    expect(
      data.messages.find((row: { id: string }) => row.id === data.trigger.messageId)?.content,
    ).toBe('My answer');
  });
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
