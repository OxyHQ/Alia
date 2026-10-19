import { describe, expect, it, vi } from 'vitest';

vi.mock('../../src/lib/agent-character', () => ({
  readAgentCharacter: (value: unknown) => ({ drawn: value ?? 'default' }),
}));
vi.mock('../../src/lib/alia-character', () => ({ ALIA_AVATAR: { preset: 'alia' } }));
vi.mock('@oxy.so/services/ui/client', () => ({
  // The host's app assertion (ADR 0021): none here (`tests/support/app-assertion-host.ts`).
  useAppAssertion: () => ({
    getAppAssertion: async () => null,
    getAppAssertionHeaders: async () => ({}),
  }),
  useOxy: () => ({}),
}));

const { ALIA_LEAD, consultedAgents, leadOf } = await import('../../src/lib/participants');
const { leadToProfile, ANCHORS } = await import('../../src/lib/flights');
const { featureOffer, readAgentFeatures, readAgentProfile } = await import(
  '../../src/runtime/agents'
);

/** Who leads a conversation and who has joined it, as data. */
describe('the lead', () => {
  it('is Alia when no agent is named', () => {
    expect(leadOf(undefined)).toBe(ALIA_LEAD);
    expect(leadOf(null)).toBe(ALIA_LEAD);
    expect(ALIA_LEAD).toMatchObject({ name: 'Alia', isAlia: true, character: { preset: 'alia' } });
  });

  it('is the agent the chat was opened on: its name, look, greeting and starters', () => {
    const profile = readAgentProfile({
      id: 'sindi',
      name: 'Sindi',
      handle: 'sindibot',
      character: { shape: 'heart' },
      color: 'teal',
      greeting: 'Hola, ¿buscas piso?',
      starters: [{ title: 'Pisos', prompt: 'Busca pisos en Barcelona' }, { title: 'bad' }],
      features: [{ key: 'attachments.documents', gated: true }],
    });
    expect(leadOf(profile)).toEqual({
      id: 'sindi',
      name: 'Sindi',
      handle: 'sindibot',
      character: { drawn: { shape: 'heart' } },
      color: 'teal',
      isAlia: false,
      greeting: 'Hola, ¿buscas piso?',
      starters: [{ title: 'Pisos', prompt: 'Busca pisos en Barcelona' }],
    });
  });

  it('flies from the greeting into the header’s participants as the lead it is', () => {
    const spec = leadToProfile(leadOf(readAgentProfile({ id: 's', name: 'S' })));
    expect(spec).toMatchObject({ from: ANCHORS.welcome, to: ANCHORS.profile });
    expect(spec.character).toEqual({ drawn: 'default' });
  });

  it('refuses a profile without an id or a name', () => {
    expect(readAgentProfile({ name: 'x' })).toBeNull();
    expect(readAgentProfile('x')).toBeNull();
  });
});

describe('the consulted agents', () => {
  it('are the agents that wrote in the conversation, once each, in order, never the lead', () => {
    const agent = (id: string, isStreaming?: boolean) => ({
      id: `m-${id}-${Math.random()}`,
      role: 'assistant' as const,
      content: '',
      agentInfo: { id, name: id.toUpperCase() },
      ...(isStreaming ? { isStreaming } : {}),
    });
    const found = consultedAgents(
      [agent('lumi'), agent('sindi', true), agent('lumi', true), agent('lead')],
      'lead',
    );
    expect(found.map(({ participant, live }) => [participant.id, live])).toEqual([
      ['lumi', false],
      ['sindi', true],
    ]);
  });
});

describe('the attach menu’s offer', () => {
  it('is everything for Alia, and for an agent exactly what its features answer lists', () => {
    expect(featureOffer(undefined, 'attachments.documents')).toBe('available');
    const features = readAgentFeatures({
      features: [
        { key: 'attachments.documents', state: 'locked', remaining: 0 },
        { key: 'attachments.images', state: 'available' },
        { key: 'x', state: 'maybe' },
      ],
    });
    expect(featureOffer(features, 'attachments.documents')).toBe('locked');
    expect(featureOffer(features, 'attachments.images')).toBe('available');
    expect(featureOffer([], 'attachments.images')).toBe('absent');
    expect(features).toHaveLength(2);
  });
});
