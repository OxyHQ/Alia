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
  const entry = OPENAI_VOICE_MAP[voice.toLowerCase()];

  switch (provider) {
    case 'openai':
    case 'openrouter':
      return entry ? voice.toLowerCase() : OPENAI_DEFAULT_VOICE;
    case 'google':
      return entry ? entry.gemini : GEMINI_DEFAULT_VOICE.female;
    case 'digitalocean':
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
  if (provider === 'digitalocean') return 'mp3';
  return requestedFormat;
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
