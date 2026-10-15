import { describe, expect, it } from 'vitest';
import { fakeRealtimeModel, fakeTranscriptionModel } from '../../kaana/fake.js';
import type { KaanaModel } from '../../kaana/port.js';
import {
  coveringLanguage,
  estimatedUsdPerCallMinute,
  rankRealtimeCandidates,
  rankTranscriptionCandidates,
  usdOfUnits,
} from '../voice-models.js';

/**
 * The voice and dictation models are COMPUTED from the catalogue (ADR 0017 §2,
 * §7). Every catalogue here is a fixture: no model id is written in product
 * code, and these tests prove the order comes from capabilities and prices.
 */

function realtime(id: string, overrides: Partial<KaanaModel> = {}): KaanaModel {
  return fakeRealtimeModel({ modelId: id, ...overrides });
}

function priced(
  unit: 'session_milliseconds' | 'audio_output_tokens',
  amount: string,
  per: number,
): Partial<KaanaModel> {
  return {
    pricing: {
      priceVersionId: 'p1',
      currency: 'USD',
      unitPrices: [{ unit, amount, per, currency: 'USD' }],
    },
  };
}

describe('languages are matched on the primary subtag only when no region is listed', () => {
  it('prefers the exact tag, accepts a bare language, refuses another region', () => {
    expect(coveringLanguage(['es', 'es-ES'], 'es-ES')).toBe('es-ES');
    expect(coveringLanguage(['es', 'en'], 'es-ES')).toBe('es');
    expect(coveringLanguage(['es-MX'], 'es-ES')).toBeNull();
    expect(coveringLanguage(['es-MX'], 'es')).toBe('es-MX');
    expect(coveringLanguage(['EN'], 'en-us')).toBe('EN');
  });
});

describe('realtime candidates (ADR 0017 §2)', () => {
  const wanted = { locale: 'es-ES', voice: 'female' as const };

  it('keeps only conversations over websocket with tools, audio both ways and input transcription', () => {
    const base = realtime('a/ok');
    const noTranscription = realtime('a/no-transcription', {
      capabilities: {
        ...base.capabilities,
        realtime: { transports: ['websocket'], sessionKinds: ['conversation'] },
      },
    });
    const noTools = realtime('a/no-tools', {
      capabilities: { ...base.capabilities, tools: false },
    });
    const transcriptionOnly = realtime('a/transcription-only', {
      capabilities: {
        ...base.capabilities,
        realtime: {
          transports: ['websocket'],
          sessionKinds: ['transcription'],
          inputAudioTranscription: true,
        },
      },
    });
    const textOut = realtime('a/text-out', {
      capabilities: { ...base.capabilities, outputModalities: ['text'] },
    });
    const deprecated = realtime('a/deprecated', { deprecation: { status: 'deprecated' } });
    const speech = fakeTranscriptionModel();
    const ranked = rankRealtimeCandidates(
      [noTranscription, noTools, transcriptionOnly, textOut, deprecated, speech, base],
      wanted,
    );
    expect(ranked.map((candidate) => candidate.model.modelId)).toEqual(['a/ok']);
  });

  it('needs the language and a voice of the product gender that speaks it; the voice id never leaves the server', () => {
    const base = realtime('a/es');
    const english = realtime('a/en', {
      audio: {
        ...base.audio!,
        languages: ['en'],
        voices: base.audio!.voices.map((v) => ({ ...v, languages: ['en'] })),
      },
    });
    const noFemale = realtime('a/male-only', {
      audio: { ...base.audio!, voices: base.audio!.voices.filter((v) => v.gender === 'male') },
    });
    const [candidate, ...rest] = rankRealtimeCandidates([english, noFemale, base], wanted);
    expect(rest).toEqual([]);
    expect(candidate?.model.modelId).toBe('a/es');
    expect(candidate?.voiceId).toBe('fake-voice-a');
    expect(candidate?.language).toBe('es');
    expect(rankRealtimeCandidates([base], { ...wanted, voice: 'male' })[0]?.voiceId).toBe(
      'fake-voice-b',
    );
  });

  it('orders by the estimated minute, unpriced last, then the newest release, then the id', () => {
    // $0.08/min by session time vs 1200 audio tokens/min at $40/M = $0.048/min.
    const sessionTime = realtime('b/session', priced('session_milliseconds', '0.08', 60_000));
    const tokens = realtime('b/tokens', priced('audio_output_tokens', '40', 1_000_000));
    const unpriced = realtime('b/unpriced', { pricing: undefined });
    const tieOld = realtime('c/old', {
      ...priced('session_milliseconds', '0.08', 60_000),
      releasedAt: '2026-01-01T00:00:00Z',
    });
    const ranked = rankRealtimeCandidates([unpriced, sessionTime, tokens, tieOld], wanted);
    expect(ranked.map((candidate) => candidate.model.modelId)).toEqual([
      'b/tokens',
      'b/session',
      'c/old',
      'b/unpriced',
    ]);
    expect(estimatedUsdPerCallMinute(sessionTime)).toBeCloseTo(0.08);
    expect(estimatedUsdPerCallMinute(tokens)).toBeCloseTo(0.048);
    expect(estimatedUsdPerCallMinute(unpriced)).toBeNull();
  });
});

describe('transcription candidates (ADR 0017 §7)', () => {
  it('need audio_transcriptions, the media type and the language; cheapest per audio millisecond first', () => {
    const cheap = fakeTranscriptionModel({
      modelId: 't/cheap',
      pricing: {
        priceVersionId: 'p',
        currency: 'USD',
        unitPrices: [
          { unit: 'audio_input_milliseconds', amount: '0.003', per: 60_000, currency: 'USD' },
        ],
      },
    });
    const dear = fakeTranscriptionModel({ modelId: 't/dear' });
    const noWebm = fakeTranscriptionModel({
      modelId: 't/no-webm',
      audio: { voices: [], languages: ['es'], audioFormats: { input: ['audio/mp4'], output: [] } },
    });
    const noSpanish = fakeTranscriptionModel({
      modelId: 't/no-es',
      audio: { voices: [], languages: ['de'], audioFormats: { input: ['audio/webm'], output: [] } },
    });
    const realtimeModel = realtime('t/realtime');
    const ranked = rankTranscriptionCandidates([dear, noWebm, noSpanish, realtimeModel, cheap], {
      mediaType: 'audio/webm',
      locale: 'es-ES',
    });
    expect(ranked.map((candidate) => candidate.model.modelId)).toEqual(['t/cheap', 't/dear']);
    expect(ranked[0]?.language).toBe('es');
  });
});

describe('prices apply to measured units, never to an estimate', () => {
  it('sums every priced unit and names the unpriced ones', () => {
    const model = realtime('p/m', {
      pricing: {
        priceVersionId: 'p',
        currency: 'USD',
        unitPrices: [
          { unit: 'session_milliseconds', amount: '0.08', per: 60_000, currency: 'USD' },
          { unit: 'audio_input_milliseconds', amount: '0.006', per: 60_000, currency: 'USD' },
        ],
      },
    });
    const { usd, unpriced } = usdOfUnits(model.pricing, [
      { unit: 'session_milliseconds', quantity: 90_000 },
      { unit: 'audio_input_milliseconds', quantity: 30_000 },
      { unit: 'audio_output_tokens', quantity: 12 },
    ]);
    expect(usd).toBeCloseTo(0.12 + 0.003);
    expect(unpriced).toEqual(['audio_output_tokens']);
  });
});
