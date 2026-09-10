import { describe, expect, it } from 'vitest';
import { readAliaMeta } from '@/components/chat/turn-failure';

/**
 * How a stream chunk is told apart from an answer.
 *
 * The server's stand-in for an answer it could not get is an ordinary content
 * delta with `alia_meta: { synthetic: true, retryable: true }` beside it —
 * and nothing else about it differs from real output. This reader is what the
 * hook consults on every content delta, so its tolerance matters as much as
 * its verdict: a throw here on an odd shape would end the stream.
 */
describe('readAliaMeta', () => {
  it('flags the server’s stand-in as synthetic and retryable', () => {
    expect(readAliaMeta({ alia_meta: { synthetic: true, retryable: true } })).toEqual({
      synthetic: true,
      retryable: true,
    });
  });

  it('honours an explicit refusal to retry', () => {
    expect(readAliaMeta({ alia_meta: { synthetic: true, retryable: false } })).toEqual({
      synthetic: true,
      retryable: false,
    });
  });

  it('treats a chunk with no meta as real output', () => {
    expect(readAliaMeta({ choices: [{ delta: { content: 'hi' } }] })).toEqual({
      synthetic: false,
      retryable: true,
    });
  });

  it('defaults retryable to true when the meta leaves it out', () => {
    expect(readAliaMeta({ alia_meta: { synthetic: true } })).toEqual({ synthetic: true, retryable: true });
  });

  it('survives every shape a chunk can have', () => {
    for (const odd of [null, undefined, 'text', 42, { alia_meta: null }, { alia_meta: 'yes' }, { alia_meta: { synthetic: 'true' } }]) {
      expect(readAliaMeta(odd)).toEqual({ synthetic: false, retryable: true });
    }
  });
});
