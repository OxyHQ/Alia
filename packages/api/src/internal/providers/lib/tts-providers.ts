/**
 * TTS Provider Knowledge
 *
 * Internal, provider-specific knowledge for text-to-speech:
 *  - Voice namespace translation between providers. The read-aloud client sends
 *    OpenAI-style voice names (nova, echo, ...); the show pipeline sends
 *    ElevenLabs voice IDs. Each provider has its own voice namespace, so a single
 *    canonical table maps every requested voice to the target provider's equivalent.
 *  - Output format per provider (OpenAI honours the requested format, DigitalOcean
 *    ElevenLabs returns MP3, Gemini returns raw PCM that we wrap in a WAV container).
 *  - PCM -> WAV encoding for Gemini, whose TTS response is raw signed 16-bit PCM.
 *  - Which bracketed cues a model can PERFORM, and how to take the rest out of a
 *    line before it is spoken.
 *
 * Keep provider names out of anything user-facing — this module is internal only.
 */

type VoiceGender = 'male' | 'female';

interface VoiceEntry {
  gender: VoiceGender;
  /** Gemini prebuilt voice name (voiceConfig.prebuiltVoiceConfig.voiceName). */
  gemini: string;
  /** ElevenLabs voice ID used by DigitalOcean fal-ai TTS. */
  elevenlabs: string;
}

/**
 * Canonical voice table keyed by OpenAI voice name — the namespace the read-aloud
 * client sends. Each row carries the equivalent voice for the other providers plus
 * a perceived gender used to pick a sensible default for unknown voices.
 * ElevenLabs IDs come from the show voice roster so both paths share one identity.
 */
const OPENAI_VOICE_MAP: Record<string, VoiceEntry> = {
  alloy: { gender: 'female', gemini: 'Leda', elevenlabs: 'EXAVITQu4vr4xnSDxMaL' },
  nova: { gender: 'female', gemini: 'Kore', elevenlabs: 'EXAVITQu4vr4xnSDxMaL' },
  shimmer: { gender: 'female', gemini: 'Aoede', elevenlabs: 'MF3mGyEYCl7XYWbV9V6O' },
  coral: { gender: 'female', gemini: 'Callirrhoe', elevenlabs: '21m00Tcm4TlvDq8ikWAM' },
  sage: { gender: 'female', gemini: 'Autonoe', elevenlabs: 'AZnzlk1XvdvUeBnXmlld' },
  echo: { gender: 'male', gemini: 'Puck', elevenlabs: 'pNInz6obpgDQGcFmaJgB' },
  onyx: { gender: 'male', gemini: 'Charon', elevenlabs: 'VR6AewLTigWG4xSOukaG' },
  fable: { gender: 'male', gemini: 'Fenrir', elevenlabs: 'ErXwobaYiN019PkySvjV' },
  ash: { gender: 'male', gemini: 'Orus', elevenlabs: 'kPzsL2i3teMYv0FxEYQ6' },
  ballad: { gender: 'male', gemini: 'Enceladus', elevenlabs: 'pNInz6obpgDQGcFmaJgB' },
  verse: { gender: 'male', gemini: 'Iapetus', elevenlabs: 'VR6AewLTigWG4xSOukaG' },
};

const GEMINI_DEFAULT_VOICE: Record<VoiceGender, string> = { female: 'Kore', male: 'Puck' };
const ELEVENLABS_DEFAULT_VOICE: Record<VoiceGender, string> = {
  female: 'EXAVITQu4vr4xnSDxMaL',
  male: 'pNInz6obpgDQGcFmaJgB',
};
const OPENAI_DEFAULT_VOICE = 'nova';

/** ElevenLabs voice IDs are 20-character alphanumeric strings (the show roster format). */
function isElevenLabsVoiceId(voice: string): boolean {
  return /^[A-Za-z0-9]{20}$/.test(voice);
}

/**
 * Translate a requested voice into the target provider's voice namespace.
 *
 * - openai/openrouter accept OpenAI voice names natively (pass through, else default).
 * - google (Gemini) needs a prebuilt voice name.
 * - digitalocean (ElevenLabs) needs a voice ID; show-pipeline IDs pass through.
 */
export function resolveVoiceForProvider(provider: string, requested: string | undefined): string {
  const voice = (requested || '').trim();
  // `requested` is the caller's own voice name. `OPENAI_VOICE_MAP` is an object
  // literal, so `OPENAI_VOICE_MAP['constructor']` is a function — truthy, so
  // every `entry ? … : default` below took the wrong branch, and the `google`
  // branch returned `entry.gemini`, which is `undefined` from a signature that
  // says `string`.
  const requestedKey = voice.toLowerCase();
  const entry = Object.hasOwn(OPENAI_VOICE_MAP, requestedKey) ? OPENAI_VOICE_MAP[requestedKey] : undefined;

  switch (provider) {
    case 'openai':
    case 'openrouter':
      return entry ? requestedKey : OPENAI_DEFAULT_VOICE;
    case 'google':
      return entry ? entry.gemini : GEMINI_DEFAULT_VOICE.female;
    // Both share one namespace because it IS one catalogue: DigitalOcean serves
    // ElevenLabs voices, by ElevenLabs voice ID. The comment sits above the
    // labels rather than between them — `no-fallthrough` reads a comment there
    // as a case that falls through with intent it cannot verify.
    case 'digitalocean':
    case 'elevenlabs':
      if (isElevenLabsVoiceId(voice)) return voice;
      return entry ? entry.elevenlabs : ELEVENLABS_DEFAULT_VOICE.female;
    default:
      return voice;
  }
}

/**
 * The audio container a provider actually returns, which may differ from the
 * requested format. Callers use this for the correct file extension / content type.
 */
export function ttsOutputFormat(provider: string, requestedFormat: string): string {
  if (provider === 'google') return 'wav';
  if (provider === 'digitalocean' || provider === 'elevenlabs') return 'mp3';
  return requestedFormat;
}

/**
 * The bracketed cues a tag-capable model performs, lower-cased.
 *
 * **English identifiers, whatever language is being spoken.** That is the
 * provider's rule and it is the whole shape of the bug this exists for: a
 * Spanish script came back carrying `[ríe]` — the model helpfully translating
 * `[laughs]` — and `[ríe]` is a tag in no model, so a voice reading it says the
 * word. A Spanish line asking for a laugh has to carry the ENGLISH `[laughs]`.
 *
 * ## Deliberately conservative, and which way an error falls
 *
 * A tag missing from this set is REMOVED from the line — the listener loses a
 * laugh they might have had. A tag wrongly in it is PASSED to the provider, and
 * a provider that does not know it speaks it. Those costs are not symmetric, so
 * the set holds only cues confirmed against the provider's own documentation,
 * and a new one is added the same way. Being incomplete degrades to the safe
 * behaviour; being generous is the original bug.
 *
 * `script-prompt.ts` names exactly this set to the model, and
 * `lib/__tests__/audio-tags.test.ts` fails if the two ever disagree — a tag the
 * prompt asks for but this set does not know would be stripped from every
 * script, silently.
 */
export const PERFORMABLE_AUDIO_TAGS: ReadonlySet<string> = new Set([
  'laughs',
  'whispers',
  'sighs',
  'sarcastic',
  'excited',
  'crying',
  'applause',
]);

/**
 * One line of text, ready for one specific model to speak.
 *
 * ## Why this takes the model's capability rather than deciding once
 *
 * The TTS tier fails over. A show line reaching `eleven_v3` should arrive with
 * its `[laughs]` intact and be performed; the same line reaching `tts-1` or
 * Gemini must arrive without it, because those read out the characters they are
 * given. So the answer differs per attempt, and only the loop that walks the
 * mappings knows which model is being asked — see `synthesize-speech.ts`.
 *
 * ## The rule for everything that is NOT a performable tag
 *
 * No bracket character survives. Not a list of stage directions to look for,
 * because the reported failure was `[ríe]` and the next is `[rires]` or
 * `[laughs nervously]`; a list of literals in any one language is exactly the
 * check that passes while the bug ships. `[` and `]` are not sounds — a voice
 * handed one either pronounces "bracket" or drops it — so nothing a listener
 * wanted is lost. The cost is the rare line where a model bracketed real words:
 * "el informe [de 2019] dice" loses three of them, against never again
 * narrating a stage direction over a whole episode.
 *
 * Parentheses and asterisks are NOT touched, though the prompt forbids them
 * too. A parenthetical aside is ordinary speech a person reads aloud — "y
 * entonces (bueno, ya sabes) pasó" — so removing it would delete words the
 * script meant to be heard, which is the opposite failure and the commoner one.
 *
 * ## And what is left has to be sayable
 *
 * Removing a span leaves debris a naive strip would hand to a provider:
 * `"Ja, ja. [ríe] Eso"` doubles a space, `"genial [ríe]."` orphans the full
 * stop, `"[ríe], claro"` orphans the comma, and `"[ríe]"` alone leaves nothing
 * at all. So whitespace is closed up, punctuation left dangling at the front is
 * dropped, and a line with no letter or digit surviving answers `''` — which
 * tells the caller this model has nothing it can say for this line, rather than
 * sending an empty `input` that every provider in the tier answers with a 400.
 */
export function speakableText(text: string, options: { readonly audioTags: boolean }): string {
  const spoken = text
    /**
     * One pass, two branches, and they must be one pass rather than two.
     *
     * A span is tried before a lone bracket because alternation is ordered, so
     * `[laughs]` matches the span and never the sweep. Sweeping strays in a
     * SECOND pass could not tell a kept tag's brackets from an unmatched one
     * and would eat the tag it had just decided to keep.
     *
     * The span is bounded to one line and to no nested `]`, so an unmatched `[`
     * cannot swallow the rest of a line. Linear — no nested quantifier.
     */
    .replace(/\[[^\]\n]*\]|[[\]]/g, (match) => {
      if (!options.audioTags) return '';
      // One lookup covers both branches of the alternation. A lone `[` or `]`
      // slices to the empty string, which is in no vocabulary, so a stray
      // bracket needs no case of its own: a `match.length` guard here was
      // MEASURED to be dead code — mutating it away changed no behaviour and
      // killed no test, which is the only evidence that settles it.
      const tag = match.slice(1, -1).trim().toLowerCase();
      // Lower-cased on the way out as well as on the way in: a model writing
      // `[Laughs]` meant the tag, and the provider's vocabulary is lower case.
      return PERFORMABLE_AUDIO_TAGS.has(tag) ? `[${tag}]` : '';
    })
    .replace(/[ \t]+([,.;:!?…])/g, '$1')
    .replace(/[ \t]{2,}/g, ' ')
    // Not `¿`, `¡`, `—` or `-`: those legitimately OPEN a line, and a Spanish
    // script's dialogue dash is not debris.
    .replace(/^[\s,.;:…]+/, '')
    .trim();

  return /[\p{L}\p{N}]/u.test(spoken) ? spoken : '';
}

const DEFAULT_PCM_SAMPLE_RATE = 24000;

/**
 * Parse the sample rate from a Gemini inline-audio mime type such as
 * "audio/L16;codec=pcm;rate=24000". Falls back to Gemini's 24 kHz default.
 */
export function parsePcmSampleRate(mimeType: string | undefined): number {
  const match = mimeType?.match(/rate=(\d+)/);
  return match ? Number.parseInt(match[1], 10) : DEFAULT_PCM_SAMPLE_RATE;
}

/**
 * Wrap raw signed 16-bit little-endian mono PCM in a minimal WAV (RIFF) container
 * so the audio is playable by browsers and standard audio elements.
 */
export function pcmToWav(pcm: Buffer, sampleRate: number): Buffer {
  const numChannels = 1;
  const bitsPerSample = 16;
  const byteRate = sampleRate * numChannels * (bitsPerSample / 8);
  const blockAlign = numChannels * (bitsPerSample / 8);
  const dataSize = pcm.length;

  const header = Buffer.alloc(44);
  header.write('RIFF', 0, 'ascii');
  header.writeUInt32LE(36 + dataSize, 4);
  header.write('WAVE', 8, 'ascii');
  header.write('fmt ', 12, 'ascii');
  header.writeUInt32LE(16, 16); // PCM fmt chunk size
  header.writeUInt16LE(1, 20); // audio format = PCM
  header.writeUInt16LE(numChannels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(bitsPerSample, 34);
  header.write('data', 36, 'ascii');
  header.writeUInt32LE(dataSize, 40);

  return Buffer.concat([header, pcm]);
}
