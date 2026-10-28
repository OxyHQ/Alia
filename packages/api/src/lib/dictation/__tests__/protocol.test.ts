import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  DICTATION_PROTOCOL_VERSION,
  DICTATION_SAMPLE_RATE,
  DICTATION_STREAM_PATH,
  parseDictationClientEvent,
} from '../protocol.js';

/**
 * The SDK restates protocol 1 (`packages/alia-chat/src/lib/dictation-protocol.ts`)
 * because it does not depend on the API package. ADR 0024 holds the two copies
 * equal: the version, the path, the sample rate, and every name either side
 * sends or reads.
 */

const sdkSource = readFileSync(
  fileURLToPath(new URL('../../../../../alia-chat/src/lib/dictation-protocol.ts', import.meta.url)),
  'utf8',
);
const apiSource = readFileSync(fileURLToPath(new URL('../protocol.ts', import.meta.url)), 'utf8');

const constant = (source: string, name: string) =>
  new RegExp(`export const ${name} = ([^;]+);`).exec(source)?.[1];

const quoted = (source: string, start: string, end: string) => {
  const from = source.indexOf(start);
  const block = source.slice(from, source.indexOf(end, from));
  return [...block.matchAll(/'([a-z][\w.-]*)'/g)].map((match) => match[1]).sort();
};

describe('protocol 1, in the API and the SDK', () => {
  it('is the same version, path and sample rate', () => {
    expect(constant(sdkSource, 'DICTATION_PROTOCOL_VERSION')).toBe(
      String(DICTATION_PROTOCOL_VERSION),
    );
    expect(constant(sdkSource, 'DICTATION_STREAM_PATH')).toBe(`'${DICTATION_STREAM_PATH}'`);
    expect(constant(sdkSource, 'DICTATION_SAMPLE_RATE')).toBe('24_000');
    expect(DICTATION_SAMPLE_RATE).toBe(24_000);
  });

  it('names the same server events and close reasons', () => {
    const events = (source: string) => quoted(source, 'export type DictationServerEvent', ';\n\n');
    expect(events(sdkSource)).toEqual(events(apiSource));
    expect(events(apiSource)).toContain('transcript.final');
    const reasons = (source: string) => quoted(source, 'export type DictationCloseReason', ';');
    expect(reasons(sdkSource)).toEqual(reasons(apiSource));
    expect(reasons(apiSource)).toContain('server-shutdown');
  });

  it('reads the client events the SDK sends, and nothing else', () => {
    for (const event of [
      { type: 'auth', token: 't' },
      { type: 'dictation.start', protocol: 1, sampleRate: 24_000, language: 'es-ES' },
      { type: 'dictation.start', protocol: 1, sampleRate: 24_000 },
      { type: 'dictation.commit' },
      { type: 'dictation.end' },
    ])
      expect(parseDictationClientEvent(JSON.stringify(event))).toEqual(event);
    expect(
      parseDictationClientEvent('{"type":"dictation.start","protocol":1,"sampleRate":16000}'),
    ).toBeNull();
    expect(parseDictationClientEvent('{"type":"dictation.end","extra":1}')).toBeNull();
    expect(parseDictationClientEvent('nope')).toBeNull();
    for (const type of ['auth', 'dictation.start', 'dictation.commit', 'dictation.end'])
      expect(sdkSource).toContain(`readonly type: '${type}'`);
  });
});
