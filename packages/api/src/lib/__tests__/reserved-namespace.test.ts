/**
 * The `alia/*` namespace reservation (ADR 0002).
 *
 * Two directions matter equally here and they fail differently. Letting an
 * `alia/*` identifier through occupies a namespace that is supposed to mean
 * something; refusing a real `publisher/model` from the catalogue breaks chat.
 * So the negative cases are as load-bearing as the positive ones.
 */

import { describe, expect, it, vi } from 'vitest';

vi.mock('../models/catalogue.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../models/catalogue.js')>()),
  listCatalogueModels: vi.fn(async () => [
    {
      id: 'example/model-1',
      name: 'Model 1',
      publisher: { id: 'example', name: 'Example' },
      description: null,
      contextWindow: 128_000,
      maxOutput: 8_192,
      inputModalities: ['text'],
      outputModalities: ['text'],
      tools: true,
      reasoningEfforts: [],
      pricing: null,
      releasedAt: null,
    },
  ]),
}));

import {
  ReservedNamespaceError,
  assertUnreservedModelIdentifier,
  isReservedModelNamespace,
} from '../reserved-namespace.js';
import { resolveModel } from '../chat-core.js';
import { ModelNotFoundError } from '../models/errors.js';

describe('the alia/* publisher namespace is reserved', () => {
  const reserved = [
    'alia/atlas',
    'alia/atlas@2026-08-01',
    'alia/a',
    'alia/',
    'ALIA/Atlas',
    'Alia/atlas',
    '  alia/atlas  ',
    'alia/nested/path',
  ];

  for (const identifier of reserved) {
    it(`refuses ${JSON.stringify(identifier)}`, () => {
      expect(isReservedModelNamespace(identifier)).toBe(true);
      expect(() => assertUnreservedModelIdentifier(identifier)).toThrow(ReservedNamespaceError);
    });
  }

  it('names the offending identifier on the error, and no provider', () => {
    // The message reaches a tool result and a log line. A model identifier is
    // Alia-branded by construction here, so naming it leaks nothing; a provider
    // name would.
    let caught: unknown = null;
    try {
      assertUnreservedModelIdentifier('alia/atlas');
    } catch (error: unknown) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ReservedNamespaceError);
    expect((caught as ReservedNamespaceError).identifier).toBe('alia/atlas');
    expect((caught as ReservedNamespaceError).message).toContain('alia/atlas');
    expect((caught as ReservedNamespaceError).message).toMatch(/reserved/i);
  });
});

describe('the reservation does not touch anything that is not in it', () => {
  const unreserved = [
    ['/alia/chat', 'a route this service mounts; its first segment is empty, not "alia"'],
    ['alia', 'a bare publisher with no model is not the <publisher>/<model> form'],
    ['aliases/atlas', 'a different publisher that merely starts with the same letters'],
    ['alia-atlas/x', 'first segment is "alia-atlas", not "alia"'],
    ['openai/gpt-4o', 'somebody else entirely'],
    ['xalia/atlas', 'suffix match, not a first segment'],
    ['', 'the empty string names nothing'],
  ] as const;

  for (const [identifier, why] of unreserved) {
    it(`allows ${JSON.stringify(identifier)} — ${why}`, () => {
      expect(isReservedModelNamespace(identifier)).toBe(false);
      expect(() => assertUnreservedModelIdentifier(identifier)).not.toThrow();
    });
  }
});

describe('the serving chokepoint refuses it, not just the validator', () => {
  /**
   * A validator with no caller is green and inert at once. This drives the real
   * entrypoint: `chat-core.resolveModel` is the one hosted-model resolver used
   * by product turns, so refusing there is refusing everywhere product code can
   * ask for inference.
   */
  it('rejects a reserved identifier before it can resolve to anything', async () => {
    await expect(resolveModel('alia/atlas')).rejects.toBeInstanceOf(ReservedNamespaceError);
    await expect(resolveModel('alia/atlas@2026-08-01')).rejects.toBeInstanceOf(ReservedNamespaceError);
  });

  it('resolves a catalogue model to itself as the Oxy target', async () => {
    const outcome = await resolveModel('example/model-1');
    expect(outcome.oxyInferenceTarget).toEqual({ kind: 'model', model: 'example/model-1' });
    expect(outcome.modelId).toBe('example/model-1');
  });

  it('refuses a model the catalogue does not offer instead of falling back', async () => {
    await expect(resolveModel('example/not-listed')).rejects.toBeInstanceOf(ModelNotFoundError);
  });
});
