import { describe, expect, it } from 'vitest';
import { parseScript, spokenText } from '../show-pipeline';
import type { ShowSpeaker } from '../../../db/schema/shows';

/**
 * A generated show must not SAY its stage directions.
 *
 * The owner listened to a finished Spanish episode and heard a voice pronounce
 * the word "ríe". The script had carried `[ríe]` — the model's own translation
 * of the `[laughs]` the prompt asked for — and nothing between the model and
 * the TTS provider removed it. `eleven_multilingual_v2`, OpenAI `tts-1` and
 * Gemini all read the characters they are handed; audio tags are an ElevenLabs
 * **v3** feature.
 *
 * ## Spanish is the subject, not a translation of the English case
 *
 * Every assertion about the reported failure uses `[ríe]`, because a test
 * written against `[laughs]` would have passed against a strip keyed on English
 * literals while the real episode still said "ríe" out loud. The English case
 * is pinned too, but it is the secondary one.
 */

const CAST: readonly ShowSpeaker[] = [
  { name: 'Marta', voiceId: 'voice-marta', voiceName: 'Marta', role: 'host' },
  { name: 'Diego', voiceId: 'voice-diego', voiceName: 'Diego', role: 'co-host' },
];
const CAST_NAMES = new Set(CAST.map((speaker) => speaker.name));

describe('spokenText', () => {
  it('takes a Spanish laughter cue out of the middle of a line', () => {
    expect(spokenText('Ja, ja. [ríe] Eso es justo lo que estaba pensando.')).toBe(
      'Ja, ja. Eso es justo lo que estaba pensando.',
    );
  });

  it('takes the cue the prompt used to ask for out of an English line', () => {
    expect(spokenText('Right, exactly. [laughs] I had the same thought.')).toBe(
      'Right, exactly. I had the same thought.',
    );
    expect(spokenText('[chuckles] Well, that depends.')).toBe('Well, that depends.');
  });

  it('is not keyed on any language: an unseen cue goes too', () => {
    expect(spokenText('Bien sûr. [rires] On y arrive.')).toBe('Bien sûr. On y arrive.');
    expect(spokenText('そうですね。[笑い] 続けましょう。')).toBe('そうですね。 続けましょう。');
    expect(spokenText('Vale. [suspira profundamente] Sigamos.')).toBe('Vale. Sigamos.');
  });

  it('leaves no doubled space, and no space orphaned in front of punctuation', () => {
    expect(spokenText('Eso es genial [ríe].')).toBe('Eso es genial.');
    expect(spokenText('Pero bueno [ríe], ya veremos.')).toBe('Pero bueno, ya veremos.');
    expect(spokenText('¿En serio [ríe]? No me lo creo.')).toBe('¿En serio? No me lo creo.');
    expect(spokenText('Sí [ríe] claro')).toBe('Sí claro');
  });

  it('leaves no punctuation orphaned at the front of a line', () => {
    expect(spokenText('[ríe], claro que sí.')).toBe('claro que sí.');
    expect(spokenText('[ríe] ... y entonces se fue.')).toBe('y entonces se fue.');
  });

  it('keeps a Spanish line that legitimately OPENS on a mark or a dash', () => {
    expect(spokenText('[ríe] ¿Y ahora qué?')).toBe('¿Y ahora qué?');
    expect(spokenText('[ríe] — Pues eso mismo.')).toBe('— Pues eso mismo.');
    expect(spokenText('[ríe] ¡Increíble!')).toBe('¡Increíble!');
  });

  it('answers an empty string when the line was nothing but a cue', () => {
    expect(spokenText('[ríe]')).toBe('');
    expect(spokenText('  [ríe]  ')).toBe('');
    // Punctuation on its own is not something a voice can say either, and an
    // empty `input` is a 400 at every TTS provider in the tier.
    expect(spokenText('[ríe]...')).toBe('');
    expect(spokenText('[ríe] [tose] —')).toBe('');
  });

  it('lets no bracket character through, matched or not', () => {
    expect(spokenText('[[risas]] Vale, sigamos.')).toBe('Vale, sigamos.');
    expect(spokenText('Vale [ríe sigamos')).toBe('Vale ríe sigamos');
    expect(spokenText('Vale] sigamos')).toBe('Vale sigamos');
  });

  it('cannot let an unmatched bracket swallow the rest of the line', () => {
    // No `]` closes the first `[` on this line, so a rule bounded only by the
    // next `]` anywhere would eat everything up to the one on the following
    // line. The words in between are speech.
    expect(spokenText('Mira [ esto es importante\ny esto también]')).toBe(
      'Mira esto es importante\ny esto también',
    );
  });

  /**
   * The positive control for every assertion above: ordinary dialogue comes
   * back byte for byte. Without this, a `spokenText` that returned `''` for
   * everything would satisfy half the file.
   */
  it('returns ordinary dialogue untouched', () => {
    const lines = [
      '¿Sabes qué? Yo también pensaba lo mismo al principio, pero cambié de opinión.',
      'Ja, ja, ja. Es que no me lo esperaba, la verdad.',
      'Mmm, no sé. Depende de a quién le preguntes — y eso es lo interesante.',
      'So, here is the thing: nobody actually reads the terms. Nobody!',
      'El informe de 2019 decía un 40%, y hoy estamos en el 68%.',
    ];
    for (const line of lines) expect(spokenText(line)).toBe(line);
  });

  /**
   * The stated trade, pinned so it is a decision and not an accident.
   *
   * A parenthetical aside is ordinary speech a person reads aloud, so stripping
   * parentheses would DELETE words the script meant to be heard — the opposite
   * failure, and the commoner one. Brackets get no such benefit of the doubt:
   * `[` is not a sound.
   */
  it('leaves parentheses and asterisks alone', () => {
    expect(spokenText('Y entonces (bueno, ya sabes) pasó lo que pasó.')).toBe(
      'Y entonces (bueno, ya sabes) pasó lo que pasó.',
    );
    expect(spokenText('Fue *muy* raro.')).toBe('Fue *muy* raro.');
  });
});

/**
 * The strip has to be REACHED, not merely correct.
 *
 * `parseScript` is the one gate between a model's reply and the voice: every
 * segment that reaches `synthesizeSpeech` came through it. A `spokenText` that
 * nothing called would pass every assertion above.
 */
describe('parseScript', () => {
  /** A reply shaped like the episode the owner actually heard. */
  function spanishReply(segments: readonly Record<string, unknown>[]): string {
    return JSON.stringify({
      description: 'Marta y Diego hablan de la vivienda en Barcelona.',
      summary: 'Un repaso al precio del alquiler y a quién lo paga.',
      recap: 'Hablamos del alquiler en Barcelona y de los pisos turísticos.',
      segments,
    });
  }

  const SPANISH_SEGMENTS = [
    { type: 'sfx', speaker: '', text: '', sfxPrompt: 'sintonía alegre de entrada, 4 segundos' },
    {
      type: 'dialogue',
      speaker: 'Marta',
      text: '¡Bienvenidos otra vez! Hoy hablamos de algo que nos toca a todos.',
    },
    {
      type: 'dialogue',
      speaker: 'Diego',
      text: 'Ja, ja. [ríe] Ya me imagino por dónde vas, Marta.',
    },
    {
      type: 'dialogue',
      speaker: 'Marta',
      text: 'El alquiler medio ha subido un 68% en diez años [suspira].',
    },
  ];

  it('strips the cue out of the dialogue that reaches the voice', () => {
    const script = parseScript(spanishReply(SPANISH_SEGMENTS), CAST_NAMES);
    expect(script).not.toBeNull();

    const dialogue = script?.segments.filter((segment) => segment.type === 'dialogue') ?? [];
    expect(dialogue.map((segment) => segment.text)).toEqual([
      '¡Bienvenidos otra vez! Hoy hablamos de algo que nos toca a todos.',
      'Ja, ja. Ya me imagino por dónde vas, Marta.',
      'El alquiler medio ha subido un 68% en diez años.',
    ]);
    // Said plainly, because this is the sentence the owner heard broken.
    for (const segment of dialogue) expect(segment.text).not.toContain('ríe');
  });

  it('hands sfx segments through untouched, prompt and all', () => {
    const script = parseScript(spanishReply(SPANISH_SEGMENTS), CAST_NAMES);
    const sfx = script?.segments.filter((segment) => segment.type === 'sfx') ?? [];
    expect(sfx).toEqual([
      { type: 'sfx', speaker: '', text: '', sfxPrompt: 'sintonía alegre de entrada, 4 segundos' },
    ]);
  });

  it('drops a dialogue segment that was only a cue, and keeps the rest', () => {
    const script = parseScript(
      spanishReply([
        ...SPANISH_SEGMENTS,
        { type: 'dialogue', speaker: 'Diego', text: '[ríe]' },
        { type: 'dialogue', speaker: 'Marta', text: 'Y con eso lo dejamos por hoy.' },
      ]),
      CAST_NAMES,
    );

    const dialogue = script?.segments.filter((segment) => segment.type === 'dialogue') ?? [];
    expect(dialogue).toHaveLength(4);
    expect(dialogue.map((segment) => segment.text)).not.toContain('');
    expect(dialogue.at(-1)?.text).toBe('Y con eso lo dejamos por hoy.');
  });

  it('rejects a reply whose dialogue was nothing BUT cues, so another provider is tried', () => {
    const script = parseScript(
      spanishReply([
        { type: 'sfx', speaker: '', text: '', sfxPrompt: 'sintonía, 4 segundos' },
        { type: 'dialogue', speaker: 'Marta', text: '[ríe]' },
        { type: 'dialogue', speaker: 'Diego', text: '[aplausos]' },
        { type: 'sfx', speaker: '', text: '', sfxPrompt: 'cierre, 3 segundos' },
      ]),
      CAST_NAMES,
    );
    expect(script).toBeNull();
  });

  it('still accepts an ordinary reply and still refuses one from outside the cast', () => {
    const clean = [
      { type: 'sfx', speaker: '', text: '', sfxPrompt: 'sintonía, 4 segundos' },
      { type: 'dialogue', speaker: 'Marta', text: 'Buenas tardes a todos.' },
      { type: 'dialogue', speaker: 'Diego', text: 'Un placer estar aquí otra vez.' },
    ];
    expect(parseScript(spanishReply(clean), CAST_NAMES)?.segments).toHaveLength(3);

    const stranger = [...clean, { type: 'dialogue', speaker: 'Lucía', text: 'Hola.' }];
    expect(parseScript(spanishReply(stranger), CAST_NAMES)).toBeNull();
  });
});

