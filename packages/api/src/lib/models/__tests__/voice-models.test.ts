import type { Model } from '@kaana.ai/contracts';
import { voiceCatalogue } from '@kaana.ai/sdk/testing';
import { describe, expect, it } from 'vitest';
import {
  rankRealtimeCandidates,
  rankTranscriptionCandidates,
  rankTranscriptionSessionCandidates,
  usdPerMinute,
} from '../voice-models.js';

/**
 * Voice and dictation models chosen from Kaana's own catalogue (the one
 * `@kaana.ai/sdk/testing` serves): by product capability and the published
 * price per minute, never by language — Kaana gives every model the language.
 */

const realtime = voiceCatalogue.find((model) => model.capabilities.realtime)!;
const transcription = voiceCatalogue.filter((model) =>
  model.capabilities.apiFormats?.includes('audio_transcriptions'),
);

function priced(model: Model, modelId: string, amount: string | undefined): Model {
  return {
    ...model,
    modelId,
    ...(amount === undefined
      ? { pricePerMinute: undefined }
      : { pricePerMinute: { amount, currency: 'USD' } }),
  } as Model;
}

describe('usdPerMinute', () => {
  it("reads the catalogue's price per minute in USD, and nothing else", () => {
    expect(usdPerMinute(priced(realtime, 'a/b', '0.08'))).toBe(0.08);
    expect(usdPerMinute(priced(realtime, 'a/b', undefined))).toBeNull();
    expect(
      usdPerMinute({ ...realtime, pricePerMinute: { amount: '0.08', currency: 'EUR' } } as Model),
    ).toBeNull();
  });
});

describe('rankRealtimeCandidates', () => {
  it("offers Kaana's realtime model with a voice of the product's gender", () => {
    for (const gender of ['female', 'male'] as const) {
      const [candidate, ...rest] = rankRealtimeCandidates(voiceCatalogue, { voice: gender });
      expect(rest).toEqual([]);
      expect(candidate?.model.modelId).toBe(realtime.modelId);
      expect(realtime.audio!.voices.find((voice) => voice.id === candidate?.voiceId)?.gender).toBe(
        gender,
      );
    }
  });

  it('orders by the cheapest minute, unpriced last, then the id', () => {
    const ranked = rankRealtimeCandidates(
      [
        priced(realtime, 'x/unpriced', undefined),
        priced(realtime, 'x/dear', '0.5'),
        priced(realtime, 'x/b-cheap', '0.01'),
        priced(realtime, 'x/a-cheap', '0.01'),
      ],
      { voice: 'female' },
    );
    expect(ranked.map((candidate) => candidate.model.modelId)).toEqual([
      'x/a-cheap',
      'x/b-cheap',
      'x/dear',
      'x/unpriced',
    ]);
  });

  it('never offers a model that cannot hold the call, or has no voice of the gender', () => {
    const retired = { ...realtime, deprecation: { status: 'retired' } } as Model;
    const noTools = {
      ...realtime,
      capabilities: { ...realtime.capabilities, tools: false },
    } as Model;
    const noVoice = {
      ...realtime,
      audio: {
        ...realtime.audio!,
        voices: realtime.audio!.voices.filter((v) => v.gender !== 'male'),
      },
    } as Model;
    expect(
      rankRealtimeCandidates([retired, noTools, ...transcription], { voice: 'female' }),
    ).toEqual([]);
    expect(rankRealtimeCandidates([noVoice], { voice: 'male' })).toEqual([]);
  });
});

describe('rankTranscriptionCandidates', () => {
  it("offers every model that takes the clip's media type, cheapest minute first", () => {
    const ranked = rankTranscriptionCandidates(voiceCatalogue, { mediaType: 'audio/webm' });
    expect(ranked.map((candidate) => candidate.model.modelId)).toEqual(
      [...transcription]
        .sort((a, b) => Number(a.pricePerMinute!.amount) - Number(b.pricePerMinute!.amount))
        .map((model) => model.modelId),
    );
    expect(ranked.length).toBeGreaterThan(1);
  });

  it('never offers a model that does not take the media type', () => {
    const ranked = rankTranscriptionCandidates(voiceCatalogue, { mediaType: 'audio/pcm' });
    for (const candidate of ranked)
      expect(candidate.model.audio!.audioFormats.input).toContain('audio/pcm');
  });
});

describe('rankTranscriptionSessionCandidates', () => {
  const sessionLine = (modelId: string, amount: string, input: string[] = ['pcm16_24khz']): Model =>
    priced(
      {
        ...transcription[0]!,
        capabilities: {
          ...transcription[0]!.capabilities,
          realtime: {
            transports: ['websocket'],
            sessionKinds: ['transcription'],
            inputAudioTranscription: false,
            audioFormats: { input, output: [] },
          },
        },
      } as Model,
      modelId,
      amount,
    );

  it('holds only lines that hold a transcription session, cheapest minute first', () => {
    const ranked = rankTranscriptionSessionCandidates([
      realtime,
      ...transcription,
      sessionLine('x/dear', '0.01'),
      sessionLine('x/cheap', '0.003'),
    ]);
    expect(ranked.map((candidate) => candidate.model.modelId)).toEqual(['x/cheap', 'x/dear']);
  });

  it('never a line that does not take 24 kHz PCM16, and none from a batch-only catalogue', () => {
    expect(
      rankTranscriptionSessionCandidates([sessionLine('x/ulaw', '0.001', ['g711_ulaw'])]),
    ).toEqual([]);
    expect(rankTranscriptionSessionCandidates(voiceCatalogue)).toEqual([]);
  });

  it('never a deprecated line', () => {
    const retired = {
      ...sessionLine('x/old', '0.001'),
      deprecation: { status: 'retired' },
    } as unknown as Model;
    expect(rankTranscriptionSessionCandidates([retired])).toEqual([]);
  });
});
