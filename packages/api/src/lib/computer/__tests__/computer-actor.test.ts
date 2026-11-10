import { describe, expect, it } from 'vitest';
import { resolveComputerActor } from '../computer-actor.js';

type Agent = Parameters<typeof resolveComputerActor>[0]['agent'];
const agent = (over: Partial<Agent> = {}): Agent => ({
  _id: 'agent-1',
  ownerOxyAccountId: 'owner-1',
  computerSource: 'alia',
  spaceId: null,
  ...over,
});

describe('resolveComputerActor', () => {
  it("is the person's shared workspace for the owner of an agent on the default", () => {
    expect(resolveComputerActor({ agent: agent(), oxyUserId: 'owner-1' })).toBe(
      'alia:user:owner-1',
    );
  });

  it("is the agent's own machine, per person, when the owner chose that", () => {
    expect(
      resolveComputerActor({ agent: agent({ computerSource: 'own' }), oxyUserId: 'owner-1' }),
    ).toBe('agent:agent-1:user:owner-1');
  });

  it("never lends a stranger's personal workspace to somebody else's agent, whatever the owner chose", () => {
    // A public agent used by another person: its owner chose `alia`, but `alia` means the OWNER's.
    const stranger = resolveComputerActor({ agent: agent(), oxyUserId: 'stranger-9' });
    expect(stranger).toBe('agent:agent-1:user:stranger-9');
    expect(stranger).not.toContain('alia:');
  });

  it('falls back to the agent’s own machine when the agent has no owner on record', () => {
    expect(
      resolveComputerActor({ agent: agent({ ownerOxyAccountId: null }), oxyUserId: 'owner-1' }),
    ).toBe('agent:agent-1:user:owner-1');
  });

  it('gives two agents of one owner the SAME machine on the default, and different ones on own', () => {
    const a = resolveComputerActor({ agent: agent({ _id: 'a' }), oxyUserId: 'owner-1' });
    const b = resolveComputerActor({ agent: agent({ _id: 'b' }), oxyUserId: 'owner-1' });
    expect(a).toBe(b);
    const ownA = resolveComputerActor({
      agent: agent({ _id: 'a', computerSource: 'own' }),
      oxyUserId: 'owner-1',
    });
    const ownB = resolveComputerActor({
      agent: agent({ _id: 'b', computerSource: 'own' }),
      oxyUserId: 'owner-1',
    });
    expect(ownA).not.toBe(ownB);
  });

  describe('an agent in a space (ADR 0028)', () => {
    it('works on the space’s shared workspace when its owner uses it on the default', () => {
      expect(
        resolveComputerActor({ agent: agent({ spaceId: 'space-1' }), oxyUserId: 'owner-1' }),
      ).toBe('space:space-1:user:owner-1');
    });

    it('gives every member of the space the SAME machine, and a different space a different one', () => {
      const a = resolveComputerActor({
        agent: agent({ _id: 'a', spaceId: 's1' }),
        oxyUserId: 'owner-1',
      });
      const b = resolveComputerActor({
        agent: agent({ _id: 'b', spaceId: 's1' }),
        oxyUserId: 'owner-1',
      });
      const c = resolveComputerActor({
        agent: agent({ _id: 'c', spaceId: 's2' }),
        oxyUserId: 'owner-1',
      });
      expect(a).toBe(b);
      expect(c).not.toBe(a);
    });

    it('keeps its own machine when its owner chose that, even inside a space', () => {
      expect(
        resolveComputerActor({
          agent: agent({ spaceId: 'space-1', computerSource: 'own' }),
          oxyUserId: 'owner-1',
        }),
      ).toBe('agent:agent-1:user:owner-1');
    });

    it('never gives a stranger’s workspace to the owner’s space: someone else gets the agent’s own machine', () => {
      const actor = resolveComputerActor({
        agent: agent({ spaceId: 'space-1' }),
        oxyUserId: 'stranger-9',
      });
      expect(actor).toBe('agent:agent-1:user:stranger-9');
      expect(actor).not.toContain('space:');
    });
  });
});
