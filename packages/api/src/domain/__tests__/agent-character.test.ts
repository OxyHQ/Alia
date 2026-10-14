import { describe, expect, it } from 'vitest';
import {
  PICKABLE_COLORS,
  PICKABLE_SHAPES,
  agentCharacterFor,
  parseAgentCharacter,
} from '../agent-character';

describe('parseAgentCharacter', () => {
  it('accepts a complete character, a preset, and a shape with a hex paint', () => {
    const complete = {
      shape: 'heart',
      eyes: 'oval',
      eyewear: 'none',
      accessory: 'bow',
      color: 'pink',
    };
    expect(parseAgentCharacter(complete)).toEqual(complete);
    expect(parseAgentCharacter({ preset: 'blue_beret' })).toEqual({ preset: 'blue_beret' });
    expect(parseAgentCharacter({ shape: 'star', bodyColor: '#FFD838' })).toEqual({
      shape: 'star',
      bodyColor: '#ffd838',
    });
  });

  it('keeps an eye spacing only inside the range', () => {
    expect(parseAgentCharacter({ preset: 'blue_beret', eyeSpacing: 1.2 })).toMatchObject({
      eyeSpacing: 1.2,
    });
    expect(parseAgentCharacter({ preset: 'blue_beret', eyeSpacing: 2 })).toBeNull();
    expect(parseAgentCharacter({ preset: 'blue_beret', eyeSpacing: Number.NaN })).toBeNull();
  });

  it('refuses a key a character does not have, so a misspelled field is not a look that never applies', () => {
    expect(parseAgentCharacter({ preset: 'blue_beret', colour: 'teal' })).toBeNull();
  });

  it('refuses what is not id-like or hex: nothing a client sends is trusted to be markup', () => {
    expect(parseAgentCharacter({ shape: '<script>', color: 'teal' })).toBeNull();
    expect(parseAgentCharacter({ shape: 'star', bodyColor: 'red' })).toBeNull();
    expect(parseAgentCharacter({ shape: 'star'.repeat(20), color: 'teal' })).toBeNull();
    expect(parseAgentCharacter({ shape: 5, color: 'teal' })).toBeNull();
  });

  it('refuses a character with nothing to draw, and anything that is not an object', () => {
    expect(parseAgentCharacter({})).toBeNull();
    expect(parseAgentCharacter({ shape: 'star' })).toBeNull();
    expect(parseAgentCharacter(null)).toBeNull();
    expect(parseAgentCharacter('teal')).toBeNull();
    expect(parseAgentCharacter([])).toBeNull();
  });

  it('does not check an id against a list: a look this copy of the vocabulary does not know is still stored', () => {
    expect(parseAgentCharacter({ shape: 'a_shape_added_next_year', color: 'teal' })).not.toBeNull();
  });
});

describe('agentCharacterFor', () => {
  it('picks the same look for the same seed, and a drawable one', () => {
    expect(agentCharacterFor('lumi')).toEqual(agentCharacterFor('lumi'));
    expect(parseAgentCharacter(agentCharacterFor('lumi'))).not.toBeNull();
  });

  it('picks from the plain set, with plain eyes and nothing on its head', () => {
    for (const seed of ['a', 'lumi', 'atlas', 'sol', 'x'.repeat(40), 'ñ']) {
      const character = agentCharacterFor(seed);
      expect(PICKABLE_SHAPES).toContain(character.shape);
      expect(PICKABLE_COLORS).toContain(character.color);
      expect(character).toMatchObject({ eyes: 'oval', eyewear: 'none', accessory: 'none' });
    }
  });

  it('spreads different seeds over more than one look', () => {
    const looks = new Set(
      Array.from({ length: 40 }, (_, i) => JSON.stringify(agentCharacterFor(`agent-${i}`))),
    );
    expect(looks.size).toBeGreaterThan(10);
  });
});
