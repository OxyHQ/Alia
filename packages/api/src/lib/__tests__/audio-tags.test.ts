import { beforeEach, describe, expect, it, vi } from 'vitest';

import { synthesizeSpeech } from '../synthesize-speech.js';
import { callProviderAPI, getModelMappingsForTier } from '../gateway-client.js';
import { buildScriptSystemPrompt } from '../show/script-prompt.js';
import {
  PERFORMABLE_AUDIO_TAGS,
  speakableText,
} from '../../internal/providers/lib/tts-providers.js';
import { GENERATED_TIER_MAPPINGS } from '../../internal/providers/lib/generate-model-mappings.js';
import {
  DEFAULT_CAPABILITIES,
  getModelCapabilities,
} from '../../internal/providers/lib/model-capabilities-data.js';
import type { ModelMapping } from '../gateway-client.js';
import type { ShowSpeaker } from '../../db/schema/shows.js';

/**
 * A bracketed cue is PERFORMED by a model that can, and never SPOKEN by one
 * that cannot.
 *
 * The owner listened to a finished Spanish episode and heard the voice
 * pronounce the word "ríe". Two separate things were wrong, and only fixing
 * both gives the right episode:
 *
 *  - the script carried `[ríe]`, a translation of `[laughs]`, and an audio tag
 *    is an ENGLISH identifier in every language — so `[ríe]` is a tag in no
 *    model and there is nothing to perform;
 *  - nothing between the model and the provider removed it, and
 *    `eleven_multilingual_v2` / `tts-1` / Gemini read out the characters they
 *    are handed.
 *
 * So the decision is per model, and `synthesizeSpeech` is the only place that
 * can make it: it walks the tier and fails over, so which model answers is not
 * known until it picks one.
 *
 * ## What this file has to catch that a strip-only test would not
 *
 * A test that only checked stripping would pass with the feature dead — every
 * line stripped, every laugh gone, nobody the wiser. So the load-bearing pair
 * is: a tag SURVIVES to a capable model, and the SAME line is stripped for an
 * incapable one.
 */

const SPANISH_WITH_TAG = 'Ya, claro... [laughs] Es que no me lo esperaba.';
const SPANISH_STRIPPED = 'Ya, claro... Es que no me lo esperaba.';

/**
 * A mapping shaped the way the SEAM delivers one, carrying the REAL capability
 * row for that model id.
 *
 * `gateway-client`'s `ModelMapping.capabilities` is `Record<string, unknown>`
 * on purpose — a remote catalogue can arrive with anything — so this is the
 * shape `synthesizeSpeech` actually reads, and the flag is looked up rather
 * than asserted here. A hand-written `{ audioTags: true }` would test this
 * file's opinion instead of the table's.
 */
function ttsMapping(provider: string, modelId: string): ModelMapping {
  const capabilities: Record<string, unknown> = { ...getModelCapabilities(modelId) };
  return { provider, modelId, priority: 1, qualityScore: 90, pricingTier: 'paid', capabilities };
}

const TAG_CAPABLE = ttsMapping('elevenlabs', 'eleven_v3');
const PLAIN = ttsMapping('openai', 'tts-1');
const V2 = ttsMapping('elevenlabs', 'eleven_multilingual_v2');

vi.mock('../gateway-client.js', () => ({
  getModelMappingsForTier: vi.fn(),
  callProviderAPI: vi.fn(),
  getProviderTimeout: vi.fn(() => 15_000),
}));

const AUDIO = Buffer.from('fake-mp3-bytes');

/** The `input` each provider was actually asked to say, in call order. */
function inputsSent(): unknown[] {
  return vi.mocked(callProviderAPI).mock.calls.map(([options]) => options.body?.input);
}

function speak(input: string): Promise<unknown> {
  return synthesizeSpeech({ input, voice: 'kPzsL2i3teMYv0FxEYQ6', format: 'mp3' });
}

beforeEach(() => {
  vi.mocked(getModelMappingsForTier).mockReset();
  vi.mocked(callProviderAPI).mockReset();
  vi.mocked(callProviderAPI).mockResolvedValue(AUDIO);
});

describe('the capability the decision rests on', () => {
  /**
   * The floor. Every assertion below is "capable model does X, incapable does
   * Y", and all of them pass vacuously if the table says both are the same.
   */
  it('is real data on the real models, not an assumption of this file', () => {
    expect(TAG_CAPABLE.capabilities.audioTags).toBe(true);
    expect(PLAIN.capabilities.audioTags).toBe(false);
    expect(V2.capabilities.audioTags).toBe(false);
    // Unknown must read as incapable: a model nobody classified speaks the tag.
    expect(DEFAULT_CAPABILITIES.audioTags).toBe(false);
  });
});

describe('synthesizeSpeech decides per model, because the tier fails over', () => {
  it('sends a tag INTACT to a model that performs it', () => {
    vi.mocked(getModelMappingsForTier).mockResolvedValue([TAG_CAPABLE]);

    return speak(SPANISH_WITH_TAG).then((result) => {
      expect(result).not.toBeNull();
      // The feature being ALIVE. If this reads `SPANISH_STRIPPED`, every laugh
      // in every episode has been deleted and the suite would otherwise be
      // perfectly green.
      expect(inputsSent()).toEqual([SPANISH_WITH_TAG]);
    });
  });

  it('sends the SAME line stripped to a model that would read it out', async () => {
    vi.mocked(getModelMappingsForTier).mockResolvedValue([PLAIN]);

    await speak(SPANISH_WITH_TAG);
    expect(inputsSent()).toEqual([SPANISH_STRIPPED]);
  });

  it('strips for the fallback after the tag-capable model fails', async () => {
    vi.mocked(getModelMappingsForTier).mockResolvedValue([TAG_CAPABLE, PLAIN]);
    vi.mocked(callProviderAPI)
      .mockRejectedValueOnce(new Error('elevenlabs is down'))
      .mockResolvedValueOnce(AUDIO);

    const result = await speak(SPANISH_WITH_TAG);

    // An episode is still produced when only the plain model answers —
    // degrading to stripped text is correct, failing is not.
    expect(result).not.toBeNull();
    expect(inputsSent()).toEqual([SPANISH_WITH_TAG, SPANISH_STRIPPED]);
  });

  it('removes a TRANSLATED tag even for the model that performs tags', async () => {
    // The reported failure, at the deepest point. `[ríe]` is a tag in no model,
    // so passing it to a tag-capable one is still a voice saying "ríe".
    vi.mocked(getModelMappingsForTier).mockResolvedValue([TAG_CAPABLE]);

    await speak('Ja, ja. [ríe] Eso es justo lo que estaba pensando.');
    expect(inputsSent()).toEqual(['Ja, ja. Eso es justo lo que estaba pensando.']);
  });

  it('removes an ordinary stage direction for the model that performs tags', async () => {
    vi.mocked(getModelMappingsForTier).mockResolvedValue([TAG_CAPABLE]);

    await speak('[he looks away] No sé qué decirte, la verdad.');
    expect(inputsSent()).toEqual(['No sé qué decirte, la verdad.']);
  });

  it('skips a model that has nothing it can say, and lets a capable one have it', async () => {
    // A line that is ONLY a cue. `tts-1` would be sent an empty `input`, which
    // is a 400; the model behind it can perform the whole line.
    vi.mocked(getModelMappingsForTier).mockResolvedValue([PLAIN, TAG_CAPABLE]);

    const result = await speak('[laughs]');

    expect(result).not.toBeNull();
    expect(vi.mocked(callProviderAPI)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(callProviderAPI).mock.calls[0]?.[0].modelId).toBe('eleven_v3');
    expect(inputsSent()).toEqual(['[laughs]']);
  });

  it('answers null without calling anything when no model can say the line', async () => {
    vi.mocked(getModelMappingsForTier).mockResolvedValue([PLAIN, V2]);

    expect(await speak('[ríe]')).toBeNull();
    expect(vi.mocked(callProviderAPI)).not.toHaveBeenCalled();
  });

  it('leaves ordinary dialogue alone whichever model answers', async () => {
    const line = '¿Sabes qué? Yo también pensaba lo mismo, pero cambié de opinión.';
    for (const mapping of [TAG_CAPABLE, PLAIN, V2]) {
      vi.mocked(callProviderAPI).mockClear();
      vi.mocked(getModelMappingsForTier).mockResolvedValue([mapping]);
      await speak(line);
      expect(inputsSent()).toEqual([line]);
    }
  });

  /**
   * A census over the LIVE chain rather than over the two models this file
   * picked, so it keeps meaning something after the chain changes — including
   * on the day a tag-capable model is admitted to it.
   */
  it('never lets a tag reach any incapable model in the live v1-tts chain', async () => {
    const chain = GENERATED_TIER_MAPPINGS['v1-tts'];
    // Vacuity floor: an empty or half-loaded chain satisfies every "was
    // stripped" assertion below and reads identically to a correct one.
    expect(chain.length).toBeGreaterThanOrEqual(5);

    for (const routed of chain) {
      const mapping = ttsMapping(routed.provider, routed.modelId);
      vi.mocked(callProviderAPI).mockClear();
      vi.mocked(getModelMappingsForTier).mockResolvedValue([mapping]);
      await speak(SPANISH_WITH_TAG);
      expect(inputsSent()).toEqual([
        routed.capabilities.audioTags ? SPANISH_WITH_TAG : SPANISH_STRIPPED,
      ]);
    }
  });
});

/**
 * The rule for everything that is not a performable tag, carried over from the
 * first pass at this bug: structural, and not a list of words in any language.
 */
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
