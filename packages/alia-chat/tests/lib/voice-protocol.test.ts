import { describe, expect, it } from 'vitest';
import { floatToPcm16, levelOfPcm16, pcm16ToFloat, resampleLinear } from '../../src/lib/pcm';
import {
  decodeAssistantAudioFrame,
  encodeAssistantAudioFrame,
  parseVoiceServerEvent,
  pcmBytesToMs,
  voiceSessionUrl,
} from '../../src/lib/voice-protocol';

describe('the voice protocol', () => {
  it('derives the socket address from the API address', () => {
    expect(voiceSessionUrl('https://api.alia.onl')).toBe('wss://api.alia.onl/v1/voice/session');
    expect(voiceSessionUrl('http://localhost:4150/')).toBe('ws://localhost:4150/v1/voice/session');
  });

  it('round-trips an assistant audio frame with its item id', () => {
    const pcm = new Uint8Array([1, 2, 3, 4]);
    const frame = encodeAssistantAudioFrame('item_ñ1', pcm);
    expect(decodeAssistantAudioFrame(frame)).toEqual({ itemId: 'item_ñ1', pcm });
    expect(decodeAssistantAudioFrame(new Uint8Array([9, 1]))).toBeNull();
  });

  it('parses the events it knows and refuses the rest', () => {
    expect(parseVoiceServerEvent('{"type":"input.ready","seq":4}')).toEqual({
      type: 'input.ready',
      seq: 4,
    });
    expect(parseVoiceServerEvent('{"type":"nope"}')).toBeNull();
    expect(parseVoiceServerEvent('not json')).toBeNull();
    expect(
      parseVoiceServerEvent('{"type":"transcript.done","role":"bot","itemId":"a","text":"x"}'),
    ).toBeNull();
  });

  it('reads an unknown error code as a failed call and an unknown close reason as an error', () => {
    expect(parseVoiceServerEvent('{"type":"error","code":"brand-new"}')).toMatchObject({
      code: 'realtime-failed',
    });
    expect(parseVoiceServerEvent('{"type":"session.closed","reason":"???"}')).toMatchObject({
      reason: 'error',
    });
  });

  it('measures PCM16 24 kHz mono in milliseconds', () => {
    expect(pcmBytesToMs(48_000)).toBe(1000);
    expect(pcmBytesToMs(1920)).toBe(40);
  });
});

describe('PCM16', () => {
  it('converts floats to little-endian PCM16 and back', () => {
    const bytes = floatToPcm16([0, 1, -1, 0.5]);
    expect(Array.from(bytes.slice(0, 6))).toEqual([0, 0, 0xff, 0x7f, 0x00, 0x80]);
    const back = pcm16ToFloat(bytes);
    expect(back[0]).toBe(0);
    expect(back[1]).toBeCloseTo(1, 3);
    expect(back[2]).toBe(-1);
    expect(back[3]).toBeCloseTo(0.5, 3);
  });

  it('resamples to the call rate', () => {
    const second = new Float32Array(48_000).fill(0.25);
    const out = resampleLinear(second, 48_000, 24_000);
    expect(out.length).toBe(24_000);
    expect(out[100]).toBeCloseTo(0.25, 5);
  });

  it('reads silence as 0 and a loud buffer as a high level', () => {
    expect(levelOfPcm16(new Uint8Array(960))).toBe(0);
    expect(levelOfPcm16(floatToPcm16(new Float32Array(480).fill(0.5)))).toBeGreaterThan(0.8);
  });
});
