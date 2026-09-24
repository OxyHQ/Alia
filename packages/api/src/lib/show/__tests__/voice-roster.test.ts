import { describe, expect, it } from 'vitest';
import type { ShowSpeaker } from '../../../db/schema/shows';
import { FORMAT_DEFAULTS, LEGACY_VOICE_IDS, SHOW_VOICES, buildSeriesCast, speakingVoices } from '../voice-roster';
import { MAX_SPEECH_INPUT_CHARS, splitForSpeech } from '../audio-text';

/** Exactly the voices Kaana's speech deployment accepts; anything else is refused as `speech.voice`. */
const KAANA_SPEECH_VOICES = new Set(['eve', 'rex', 'ara', 'sal', 'leo']);

describe('the show voice roster', () => {
  it('names only voices the speech endpoint accepts, each once', () => {
    const ids = SHOW_VOICES.map((voice) => voice.voiceId);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(KAANA_SPEECH_VOICES.has(id)).toBe(true);
  });

  it('keeps product labels, never upstream voice slugs, as what a listener hears', () => {
    for (const voice of SHOW_VOICES) {
      expect(KAANA_SPEECH_VOICES.has(voice.name.toLowerCase())).toBe(false);
      expect(`${voice.name} ${voice.description} ${voice.accent}`).not.toMatch(/xai|grok|elevenlabs|kaana/i);
    }
    // The long-standing default hosts keep their names.
    expect(buildSeriesCast('podcast').map((speaker) => speaker.name)).toEqual(['Marcus', 'Sarah']);
  });

  it('casts every format with distinct, accepted voices', () => {
    for (const format of Object.keys(FORMAT_DEFAULTS) as (keyof typeof FORMAT_DEFAULTS)[]) {
      const cast = buildSeriesCast(format);
      expect(cast).toHaveLength(FORMAT_DEFAULTS[format].roles.length);
      expect(new Set(cast.map((speaker) => speaker.voiceId)).size).toBe(cast.length);
      for (const speaker of cast) {
        expect(KAANA_SPEECH_VOICES.has(speaker.voiceId)).toBe(true);
        expect(speaker.name).toBe(speaker.voiceName);
      }
    }
  });

  it('honours a requested voice, translating a retired id, and never duplicates', () => {
    expect(buildSeriesCast('podcast', ['leo', 'eve']).map((s) => s.voiceId)).toEqual(['leo', 'eve']);
    expect(buildSeriesCast('podcast', ['pNInz6obpgDQGcFmaJgB']).map((s) => s.voiceId)).toEqual(['leo', 'ara']);
    const clash = buildSeriesCast('podcast', ['rex', 'rex']).map((s) => s.voiceId);
    expect(clash[0]).toBe('rex');
    expect(clash[1]).not.toBe('rex');
    expect(buildSeriesCast('podcast', ['nope']).map((s) => s.voiceId)).toEqual(['rex', 'ara']);
  });
});

describe('speakingVoices: a stored cast, spoken in current voices', () => {
  const speaker = (name: string, voiceId: string, role: ShowSpeaker['role'] = 'host'): ShowSpeaker => ({
    name,
    voiceId,
    voiceName: name,
    role,
  });

  it('translates every retired id to an accepted voice', () => {
    for (const [legacy, current] of LEGACY_VOICE_IDS) {
      expect(KAANA_SPEECH_VOICES.has(current)).toBe(true);
      expect(speakingVoices([speaker('Anyone', legacy)]).get('Anyone')).toBe(current);
    }
  });

  it('gives the pre-switch default podcast cast the voices a new series would get', () => {
    const voices = speakingVoices([
      speaker('Marcus', 'kPzsL2i3teMYv0FxEYQ6'),
      speaker('Sarah', 'EXAVITQu4vr4xnSDxMaL', 'co-host'),
    ]);
    expect(voices.get('Marcus')).toBe('rex');
    expect(voices.get('Sarah')).toBe('ara');
  });

  it('keeps two hosts distinct when their retired voices share a successor', () => {
    const voices = speakingVoices([
      speaker('Adam', 'pNInz6obpgDQGcFmaJgB'),
      speaker('Arnold', 'VR6AewLTigWG4xSOukaG', 'co-host'),
    ]);
    expect(voices.get('Adam')).toBe('leo');
    // Re-cast within the same gender first.
    expect(voices.get('Arnold')).toBe('rex');
  });

  it('answers no retired voice for a prototype key', () => {
    expect(speakingVoices([speaker('Sarah', 'constructor')]).get('Sarah')).toBe('ara');
  });

  it('falls back to the voice named like the speaker, then to any unused one', () => {
    expect(speakingVoices([speaker('Sarah', 'v2')]).get('Sarah')).toBe('ara');
    const voices = speakingVoices([speaker('Zoe', 'v1'), speaker('Yan', 'v2')]);
    expect(voices.get('Zoe')).toBeDefined();
    expect(voices.get('Yan')).toBeDefined();
    expect(voices.get('Zoe')).not.toBe(voices.get('Yan'));
  });
});

describe('splitForSpeech: no request over the speech input ceiling', () => {
  it('leaves an ordinary line whole', () => {
    expect(splitForSpeech('Welcome back to the show.')).toEqual(['Welcome back to the show.']);
    expect(splitForSpeech('')).toEqual([]);
  });

  it('splits on sentences, within the ceiling, losing no words', () => {
    const sentence = 'This sentence is exactly forty-four chars. ';
    const text = sentence.repeat(1000).trim();
    const pieces = splitForSpeech(text);
    expect(pieces.length).toBeGreaterThan(1);
    for (const piece of pieces) {
      expect(piece.length).toBeLessThanOrEqual(MAX_SPEECH_INPUT_CHARS);
      expect(piece.endsWith('.')).toBe(true);
    }
    expect(pieces.join(' ')).toBe(text);
  });

  it('cuts a run with no boundary without splitting a surrogate pair', () => {
    const pieces = splitForSpeech('a' + '😀'.repeat(10), 6);
    for (const piece of pieces) {
      expect(piece.length).toBeLessThanOrEqual(6);
      expect(piece).not.toMatch(/[\uD800-\uDBFF]$/u);
    }
    expect(pieces.join('')).toBe('a' + '😀'.repeat(10));
  });
});
