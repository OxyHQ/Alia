/**
 * Feature gates (ADR 0020 §6): what a gate covers, what the app's answers
 * mean, and that a part is spent once however often the history is resent.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  check: { status: 'answered', result: { available: true } } as Record<string, unknown>,
  consume: { status: 'answered', result: { consumed: true } } as Record<string, unknown>,
  declared: { checkTool: 'readFiles', consumeTool: 'spendFile' } as Record<string, unknown> | null,
  calls: [] as Array<{ tool: string; key?: string }>,
}));

vi.mock('../tools/oxy-services.js', () => ({
  presentPersonAgentContext: (params: { personAccountId: string; accessToken: string }) => ({
    requesterAccountId: params.personAccountId,
    ownerAccountId: params.personAccountId,
    actor: { type: 'agent', accountId: 'bot' },
    userAccessToken: params.accessToken,
  }),
  findOxyAppFeature: async (_app: string, key: string) =>
    mocks.declared === null
      ? null
      : { feature: { key, description: 'x', ...mocks.declared }, toolsTakeNoInput: true },
  callOxyFeatureTool: async (_lane: unknown, _app: string, tool: string, key?: string) => {
    mocks.calls.push({ tool, ...(key === undefined ? {} : { key }) });
    return tool === 'readFiles' ? mocks.check : mocks.consume;
  },
}));

import { DEFAULT_POWER_LEVEL, POWER_LEVELS } from '../models/power-levels.js';
import { GATEABLE_POWER_LEVELS, GATED_FEATURES } from '../../domain/agent-features.js';
import {
  attachedPartsOf,
  gatesAnyPowerLevel,
  turnFeatureUsesOf,
  checkGatedParts,
  gatedPartsFor,
  readAgentFeatures,
  refuseFeatureGates,
  spendGatedParts,
  FeatureCheckUnavailableError,
} from '../agent-features.js';
import type { ChatMessage } from '../message-converter.js';

const agent = {
  oxyAccountId: 'bot',
  ownerOxyAccountId: 'owner',
  featureGates: { 'attachments.documents': { app: 'homiio', feature: 'files' } },
};
const person = { accountId: 'person', accessToken: 'TOKEN', runId: 'run' };

const turn = (id?: string): ChatMessage => ({
  ...(id === undefined ? {} : { id }),
  role: 'user',
  content: [
    { type: 'text', text: 'read this' },
    { type: 'file', file: { file_id: 'file-1', filename: 'lease.pdf' } },
    { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } },
  ],
});

beforeEach(() => {
  mocks.check = { status: 'answered', result: { available: true, remaining: 3 } };
  mocks.consume = { status: 'answered', result: { consumed: true } };
  mocks.declared = { checkTool: 'readFiles', consumeTool: 'spendFile' };
  mocks.calls.length = 0;
});

describe('attachedPartsOf', () => {
  it("names each user message's documents and images, the history's included", () => {
    const parts = attachedPartsOf(
      [turn('m1'), { role: 'assistant', content: 'ok' }, turn('m2')],
      'req',
    );
    expect(parts.map((part) => part.feature)).toEqual([
      'attachments.documents',
      'attachments.images',
      'attachments.documents',
      'attachments.images',
    ]);
  });

  it('keys a spend by the carrying message and the part, so a resent history spends nothing new', () => {
    const first = attachedPartsOf([turn('m1')], 'request-1');
    const retried = attachedPartsOf([turn('m1')], 'request-2');
    const later = attachedPartsOf(
      [turn('m1'), { role: 'assistant', content: 'ok' }, { role: 'user', content: 'and?' }],
      'request-3',
    );
    expect(retried).toEqual(first);
    expect(later).toEqual(first);
    // The same file in another message is another attachment.
    expect(attachedPartsOf([turn('m9')], 'request-1')[0].operationKey).not.toBe(
      first[0].operationKey,
    );
    expect(first[0].operationKey).toMatch(/^[0-9a-f]{64}$/);
  });

  it('falls back to the request and position for a message without an id', () => {
    expect(attachedPartsOf([turn()], 'a')[0].operationKey).not.toBe(
      attachedPartsOf([turn()], 'b')[0].operationKey,
    );
  });

  it('covers only what the agent gates', () => {
    const parts = attachedPartsOf([turn('m1')], 'req');
    expect(gatedPartsFor(agent, parts).map((part) => part.feature)).toEqual([
      'attachments.documents',
    ]);
  });
});

describe('checkGatedParts', () => {
  const parts = () => gatedPartsFor(agent, attachedPartsOf([turn('m1')], 'req'));

  it('admits an available feature', async () => {
    expect(await checkGatedParts(agent, person, parts())).toBeNull();
    expect(mocks.calls).toEqual([{ tool: 'readFiles' }]);
  });

  it('refuses a locked feature as an entitlement the person lacks', async () => {
    mocks.check = { status: 'answered', result: { available: false } };
    expect(await checkGatedParts(agent, person, parts())).toEqual({
      code: 'feature_entitlement_required',
      feature: 'attachments.documents',
      retryable: false,
    });
  });

  it('reads a lane that does not reach the tool as locked', async () => {
    mocks.check = { status: 'unbound' };
    expect((await checkGatedParts(agent, person, parts()))?.code).toBe(
      'feature_entitlement_required',
    );
  });

  it('never reads an app that could not answer, or answered nonsense, as either verdict', async () => {
    mocks.check = { status: 'unavailable' };
    expect(await checkGatedParts(agent, person, parts())).toEqual({
      code: 'feature_check_unavailable',
      feature: 'attachments.documents',
      retryable: true,
    });
    mocks.check = { status: 'answered', result: { ok: true } };
    expect((await checkGatedParts(agent, person, parts()))?.code).toBe('feature_check_unavailable');
  });

  it('is locked without the person’s own bearer, and when the app stopped declaring it', async () => {
    expect(
      (await checkGatedParts(agent, { ...person, accessToken: undefined }, parts()))?.code,
    ).toBe('feature_entitlement_required');
    mocks.declared = null;
    expect((await checkGatedParts(agent, person, parts()))?.code).toBe(
      'feature_entitlement_required',
    );
  });
});

describe('spendGatedParts', () => {
  const parts = () => gatedPartsFor(agent, attachedPartsOf([turn('m1')], 'req'));

  it('spends each gated part under its own key', async () => {
    expect(await spendGatedParts(agent, person, parts())).toBeNull();
    expect(mocks.calls).toEqual([{ tool: 'spendFile', key: parts()[0].operationKey }]);
  });

  it('refuses what the app would not spend', async () => {
    mocks.consume = { status: 'answered', result: { consumed: false } };
    expect((await spendGatedParts(agent, person, parts()))?.code).toBe(
      'feature_entitlement_required',
    );
    mocks.consume = { status: 'unavailable' };
    expect((await spendGatedParts(agent, person, parts()))?.code).toBe('feature_check_unavailable');
  });

  it('spends nothing for a feature with no consumeTool', async () => {
    mocks.declared = { checkTool: 'readFiles' };
    expect(await spendGatedParts(agent, person, parts())).toBeNull();
    expect(mocks.calls).toEqual([]);
  });
});

describe('readAgentFeatures', () => {
  it('answers every Alia feature, ungated ones available', async () => {
    expect(await readAgentFeatures(agent, person)).toEqual([
      { key: 'attachments.documents', state: 'available', remaining: 3 },
      { key: 'attachments.images', state: 'available' },
      { key: 'deep_research', state: 'available' },
      { key: 'power_level.pro', state: 'available' },
      { key: 'power_level.ultra', state: 'available' },
    ]);
  });

  it('throws rather than guess when an app cannot answer', async () => {
    mocks.check = { status: 'unavailable' };
    await expect(readAgentFeatures(agent, person)).rejects.toBeInstanceOf(
      FeatureCheckUnavailableError,
    );
  });
});

describe('refuseFeatureGates', () => {
  it('accepts a declared feature and refuses one the app does not declare', async () => {
    expect(await refuseFeatureGates(agent.featureGates)).toBeNull();
    mocks.declared = null;
    expect(await refuseFeatureGates(agent.featureGates)).toContain('declares no feature "files"');
  });
});

describe('the gateable vocabulary', () => {
  it('gates only the levels a turn reaches by naming them, never auto or what auto climbs to', () => {
    expect(GATEABLE_POWER_LEVELS).toEqual(['pro', 'ultra']);
    for (const level of GATEABLE_POWER_LEVELS) expect(POWER_LEVELS).toContain(level);
    expect(GATEABLE_POWER_LEVELS).not.toContain(DEFAULT_POWER_LEVEL);
    expect(GATED_FEATURES).toEqual([
      'attachments.documents',
      'attachments.images',
      'deep_research',
      'power_level.pro',
      'power_level.ultra',
    ]);
  });
});

describe('turnFeatureUsesOf', () => {
  const history = [
    turn('m1'),
    { id: 'a1', role: 'assistant', content: 'ok' },
    { id: 'm2', role: 'user', content: 'go deeper' },
  ];

  it('adds deep research and a gateable level to the attachments, keyed by the turn’s own message', () => {
    const uses = turnFeatureUsesOf(history, 'req-1', { deepResearch: true, powerLevel: 'pro' });
    expect(uses.map((use) => use.feature)).toEqual([
      'attachments.documents',
      'attachments.images',
      'deep_research',
      'power_level.pro',
    ]);
    // A retry of the same turn spends nothing new; the next turn is a new use.
    expect(turnFeatureUsesOf(history, 'req-2', { deepResearch: true, powerLevel: 'pro' })).toEqual(
      uses,
    );
    const next = turnFeatureUsesOf(
      [...history, { id: 'm3', role: 'user', content: 'again' }],
      'req-3',
      {
        deepResearch: true,
        powerLevel: 'pro',
      },
    );
    expect(next[2].operationKey).not.toBe(uses[2].operationKey);
  });

  it('never makes a use of auto, instant or a level auto climbs to', () => {
    for (const powerLevel of ['auto', 'instant', 'medium', 'high', 'xhigh', null]) {
      expect(
        turnFeatureUsesOf([{ role: 'user', content: 'hi' }], 'r', {
          deepResearch: false,
          powerLevel,
        }),
      ).toEqual([]);
    }
  });

  it('knows when an agent gates a level', () => {
    expect(gatesAnyPowerLevel(agent)).toBe(false);
    expect(
      gatesAnyPowerLevel({
        ...agent,
        featureGates: { 'power_level.ultra': { app: 'clarity', feature: 'ultra' } },
      }),
    ).toBe(true);
  });
});
