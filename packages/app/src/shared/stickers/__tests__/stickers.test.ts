import { describe, expect, it } from 'vitest';
import { EMPTY_STATE_STICKERS } from '../stickers';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

describe('the empty-state stickers', () => {
  it('names a catalogue id for every screen', () => {
    for (const [name, id] of Object.entries(EMPTY_STATE_STICKERS)) {
      expect(id, name).toMatch(UUID);
    }
  });
});
