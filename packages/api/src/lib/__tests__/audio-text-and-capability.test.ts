import { describe, expect, it } from 'vitest';

import { synthesizeSpeech } from '../synthesize-speech.js';
import { buildScriptSystemPrompt } from '../show/script-prompt.js';
import { PERFORMABLE_AUDIO_TAGS, speakableText } from '../show/audio-text.js';
import type { ShowSpeaker } from '../../db/schema/shows.js';

describe('synthesizeSpeech', () => {
  it('fails closed without resolving an Alia-hosted TTS provider', async () => {
    await expect(
      synthesizeSpeech({ input: 'hello', voice: 'nova', format: 'mp3' }),
    ).rejects.toMatchObject({
      name: 'KaanaCapabilityUnavailableError',
      code: 'KAANA_CAPABILITY_UNAVAILABLE',
      httpStatus: 503,
      capability: 'speech_synthesis',
    });
  });
});

describe('speakableText', () => {
  const PLAIN_MODEL = { audioTags: false } as const;
  const TAG_MODEL = { audioTags: true } as const;

  it('takes a Spanish laughter cue out of the middle of a line', () => {
    expect(speakableText('Ja, ja. [ríe] Eso es justo lo que estaba pensando.', PLAIN_MODEL)).toBe(
      'Ja, ja. Eso es justo lo que estaba pensando.',
    );
  });

  it('is not keyed on any language: an unseen cue goes too', () => {
    expect(speakableText('Bien sûr. [rires] On y arrive.', PLAIN_MODEL)).toBe('Bien sûr. On y arrive.');
    expect(speakableText('そうですね。[笑い] 続けましょう。', PLAIN_MODEL)).toBe('そうですね。 続けましょう。');
    expect(speakableText('Vale. [suspira profundamente] Sigamos.', PLAIN_MODEL)).toBe('Vale. Sigamos.');
  });

  it('leaves no doubled space, and no space orphaned in front of punctuation', () => {
    expect(speakableText('Eso es genial [ríe].', PLAIN_MODEL)).toBe('Eso es genial.');
    expect(speakableText('Pero bueno [ríe], ya veremos.', PLAIN_MODEL)).toBe('Pero bueno, ya veremos.');
    expect(speakableText('¿En serio [ríe]? No me lo creo.', PLAIN_MODEL)).toBe('¿En serio? No me lo creo.');
    expect(speakableText('Sí [ríe] claro', PLAIN_MODEL)).toBe('Sí claro');
  });

  it('leaves no punctuation orphaned at the front of a line', () => {
    expect(speakableText('[ríe], claro que sí.', PLAIN_MODEL)).toBe('claro que sí.');
    expect(speakableText('[ríe] ... y entonces se fue.', PLAIN_MODEL)).toBe('y entonces se fue.');
  });

  it('keeps a Spanish line that legitimately OPENS on a mark or a dash', () => {
    expect(speakableText('[ríe] ¿Y ahora qué?', PLAIN_MODEL)).toBe('¿Y ahora qué?');
    expect(speakableText('[ríe] — Pues eso mismo.', PLAIN_MODEL)).toBe('— Pues eso mismo.');
    expect(speakableText('[ríe] ¡Increíble!', PLAIN_MODEL)).toBe('¡Increíble!');
  });

  it('answers an empty string when nothing sayable is left', () => {
    expect(speakableText('[ríe]', PLAIN_MODEL)).toBe('');
    expect(speakableText('[laughs]', PLAIN_MODEL)).toBe('');
    // Punctuation on its own is not something a voice can say either, and an
    // empty `input` is a 400 at every TTS provider in the tier.
    expect(speakableText('[ríe]...', PLAIN_MODEL)).toBe('');
    expect(speakableText('[ríe] [tose] —', PLAIN_MODEL)).toBe('');
    // ...but a cue-only line IS sayable by a model that performs it.
    expect(speakableText('[laughs]', TAG_MODEL)).toBe('[laughs]');
  });

  it('lets no bracket character through, matched or not', () => {
    expect(speakableText('[[risas]] Vale, sigamos.', PLAIN_MODEL)).toBe('Vale, sigamos.');
    expect(speakableText('Vale [ríe sigamos', PLAIN_MODEL)).toBe('Vale ríe sigamos');
    expect(speakableText('Vale] sigamos', PLAIN_MODEL)).toBe('Vale sigamos');
    // And a stray bracket goes even when tags are being kept — the sweep must
    // not be the thing that eats a tag it just decided to keep.
    expect(speakableText('Vale] sigamos [laughs]', TAG_MODEL)).toBe('Vale sigamos [laughs]');
  });

  it('cannot let an unmatched bracket swallow the rest of the line', () => {
    // No `]` closes the first `[` on this line, so a rule bounded only by the
    // next `]` anywhere would eat everything up to the one on the following
    // line. The words in between are speech.
    expect(speakableText('Mira [ esto es importante\ny esto también]', PLAIN_MODEL)).toBe(
      'Mira esto es importante\ny esto también',
    );
  });

  it('returns ordinary dialogue untouched, for both kinds of model', () => {
    const lines = [
      '¿Sabes qué? Yo también pensaba lo mismo al principio, pero cambié de opinión.',
      'Ja, ja, ja. Es que no me lo esperaba, la verdad.',
      'Mmm, no sé. Depende de a quién le preguntes — y eso es lo interesante.',
      'So, here is the thing: nobody actually reads the terms. Nobody!',
      'El informe de 2019 decía un 40%, y hoy estamos en el 68%.',
    ];
    for (const line of lines) {
      expect(speakableText(line, PLAIN_MODEL)).toBe(line);
      expect(speakableText(line, TAG_MODEL)).toBe(line);
    }
  });

  /**
   * The stated trade, pinned so it is a decision and not an accident. A
   * parenthetical aside is ordinary speech a person reads aloud, so stripping
   * parentheses would DELETE words the script meant to be heard — the opposite
   * failure, and the commoner one. Brackets get no such benefit of the doubt:
   * `[` is not a sound.
   */
  it('leaves parentheses and asterisks alone', () => {
    expect(speakableText('Y entonces (bueno, ya sabes) pasó lo que pasó.', PLAIN_MODEL)).toBe(
      'Y entonces (bueno, ya sabes) pasó lo que pasó.',
    );
    expect(speakableText('Fue *muy* raro.', PLAIN_MODEL)).toBe('Fue *muy* raro.');
  });

  it('accepts a tag however the model capitalised or spaced it, and normalises it', () => {
    expect(speakableText('Bueno [Laughs] ya está.', TAG_MODEL)).toBe('Bueno [laughs] ya está.');
    expect(speakableText('Bueno [ WHISPERS ] ya está.', TAG_MODEL)).toBe('Bueno [whispers] ya está.');
  });

  it('refuses a tag that only looks like one', () => {
    // A near miss is not a tag: the provider would read it out, which is the
    // whole failure. The prompt says so; this is what makes it true.
    expect(speakableText('Bueno [laughs nervously] ya está.', TAG_MODEL)).toBe('Bueno ya está.');
    expect(speakableText('Bueno [giggles] ya está.', TAG_MODEL)).toBe('Bueno ya está.');
  });

  it('keeps every tag the vocabulary claims is performable', () => {
    // A census over the real set, so a tag added to it without working here
    // fails rather than being silently deleted from every script.
    expect(PERFORMABLE_AUDIO_TAGS.size).toBeGreaterThanOrEqual(5);
    for (const tag of PERFORMABLE_AUDIO_TAGS) {
      expect(speakableText(`Vale [${tag}] sigamos.`, TAG_MODEL)).toBe(`Vale [${tag}] sigamos.`);
      expect(speakableText(`Vale [${tag}] sigamos.`, PLAIN_MODEL)).toBe('Vale sigamos.');
    }
  });
});

/**
 * The prompt's half: ask for the tags that exist, in English, and nothing else
 * in brackets.
 */
describe('the script prompt', () => {
  const CAST: readonly ShowSpeaker[] = [
    { name: 'Marta', voiceId: 'voice-marta', voiceName: 'Marta', role: 'host' },
    { name: 'Diego', voiceId: 'voice-diego', voiceName: 'Diego', role: 'co-host' },
  ];

  /** A stage-direction-shaped token: a bracket around something, on one line. */
  function bracketedTokens(prompt: string): string[] {
    return [...prompt.matchAll(/\[([^\]\s][^\]\n]*)\]/g)].map((match) => match[1] ?? '');
  }

  it('asks for exactly the tags that exist, and no others', () => {
    for (const format of ['podcast', 'news', 'debate', 'interview', 'explainer'] as const) {
      const named = bracketedTokens(buildScriptSystemPrompt(format, CAST));

      // Floor: a prompt naming no tokens at all would satisfy the partition below.
      expect(named.length).toBeGreaterThan(PERFORMABLE_AUDIO_TAGS.size);

      const asked = named.filter((token) => PERFORMABLE_AUDIO_TAGS.has(token));
      expect(new Set(asked)).toEqual(new Set(PERFORMABLE_AUDIO_TAGS));

      /**
       * Everything else the prompt puts in brackets is a NEGATIVE example, and
       * naming them exactly is the point: a token added here without being
       * classified fails this, and the cheapest green is to decide which side
       * it is on rather than to let the model start emitting it.
       */
      const forbidden = named.filter((token) => !PERFORMABLE_AUDIO_TAGS.has(token));
      expect(new Set(forbidden)).toEqual(new Set(['ríe', 'he looks away', 'laughs nervously']));
    }
  });

  it('says the tag names stay English in a script that is not', () => {
    const prompt = buildScriptSystemPrompt('podcast', CAST);
    // The load-bearing sentence: the reported failure was a model TRANSLATING
    // the cue along with the rest of the script, so leaving this implicit is
    // what produced "[ríe]".
    expect(prompt).toMatch(/ALWAYS these ENGLISH words, no matter what language/);
    expect(prompt).toContain('NEVER "[ríe]"');
  });

  it('still forbids an ordinary stage direction', () => {
    const prompt = buildScriptSystemPrompt('podcast', CAST);
    expect(prompt).toContain('Nothing else goes in brackets');
    expect(prompt).toContain('[he looks away]');
  });

  /**
   * The two lists cannot drift, because there is only one: the prompt renders
   * `PERFORMABLE_AUDIO_TAGS`. This asserts the render actually happened — a
   * hand-typed list would pass every check above on the day it was written and
   * rot on the next edit.
   */
  it('renders the tag list from the set the strip enforces', () => {
    const prompt = buildScriptSystemPrompt('podcast', CAST);
    expect(prompt).toContain([...PERFORMABLE_AUDIO_TAGS].map((tag) => `[${tag}]`).join(', '));
  });
});
