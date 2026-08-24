/**
 * The voices a show series can be cast from.
 *
 * ## The cast belongs to the SERIES, and is chosen before any script exists
 *
 * The previous pipeline generated a script, let the model invent speaker names,
 * and then matched those names to voices — per episode. Two things followed, and
 * both were bugs rather than quirks: a podcast's hosts changed voice between
 * episodes, and a model that spelled a name differently in one segment than in
 * its own `speakers` list produced a segment with no voice at all, which the
 * pipeline logged and dropped.
 *
 * Now the cast is built ONCE, when the series is created, from the format alone.
 * Each speaker's NAME is its voice's name, so the two can never disagree, and
 * the script prompt is told who is speaking rather than asked to decide.
 *
 * Voice ids are for `fal-ai/elevenlabs/tts/multilingual-v2`, reached through the
 * shared multi-provider synthesis path.
 */

import type { ShowFormat, ShowSpeaker, ShowSpeakerRole } from '../../db/schema/shows.js';

export interface ShowVoice {
  voiceId: string;
  name: string;
  gender: 'male' | 'female';
  accent: string;
  description: string;
}

export const SHOW_VOICES: ShowVoice[] = [
  { voiceId: 'kPzsL2i3teMYv0FxEYQ6', name: 'Marcus', gender: 'male', accent: 'American', description: 'Warm, conversational male voice' },
  { voiceId: 'pNInz6obpgDQGcFmaJgB', name: 'Adam', gender: 'male', accent: 'American', description: 'Deep, authoritative male voice' },
  { voiceId: 'ErXwobaYiN019PkySvjV', name: 'Antoni', gender: 'male', accent: 'American', description: 'Well-rounded, clear male voice' },
  { voiceId: 'VR6AewLTigWG4xSOukaG', name: 'Arnold', gender: 'male', accent: 'American', description: 'Crisp, strong male voice' },
  { voiceId: 'EXAVITQu4vr4xnSDxMaL', name: 'Sarah', gender: 'female', accent: 'American', description: 'Soft, friendly female voice' },
  { voiceId: '21m00Tcm4TlvDq8ikWAM', name: 'Rachel', gender: 'female', accent: 'American', description: 'Calm, professional female voice' },
  { voiceId: 'MF3mGyEYCl7XYWbV9V6O', name: 'Emily', gender: 'female', accent: 'American', description: 'Young, energetic female voice' },
  { voiceId: 'AZnzlk1XvdvUeBnXmlld', name: 'Domi', gender: 'female', accent: 'American', description: 'Strong, confident female voice' },
];

export type FormatRoles = {
  roles: Array<{ role: ShowSpeakerRole; defaultGender: 'male' | 'female' }>;
};

/**
 * How many people a format has, and who they are.
 *
 * This is also what decides how many voices a series is cast with, so a format
 * added here without a role list would produce a series nobody speaks in.
 */
export const FORMAT_DEFAULTS: Record<ShowFormat, FormatRoles> = {
  podcast: {
    roles: [
      { role: 'host', defaultGender: 'male' },
      { role: 'co-host', defaultGender: 'female' },
    ],
  },
  news: {
    roles: [
      { role: 'host', defaultGender: 'female' },
      { role: 'co-host', defaultGender: 'male' },
    ],
  },
  debate: {
    roles: [
      { role: 'host', defaultGender: 'male' },
      { role: 'guest', defaultGender: 'female' },
      { role: 'narrator', defaultGender: 'male' },
    ],
  },
  interview: {
    roles: [
      { role: 'host', defaultGender: 'female' },
      { role: 'guest', defaultGender: 'male' },
    ],
  },
  explainer: {
    roles: [
      { role: 'narrator', defaultGender: 'female' },
    ],
  },
};

/**
 * Cast a series: one distinct voice per role the format calls for.
 *
 * `requestedVoiceIds` lets the owner choose, positionally by role. An id that
 * names no voice in the roster, or one already taken by an earlier role, is
 * ignored rather than rejected — the caller gets a complete cast either way,
 * because a series half-cast is not a state anything downstream can use.
 *
 * Every speaker's `name` IS its voice's name. That is the invariant the whole
 * pipeline rests on: `show-pipeline.ts` looks a segment's `speaker` up in this
 * list to find the voice to synthesise it with, so a name that is not a
 * roster name is a segment with no voice.
 */
export function buildSeriesCast(
  format: ShowFormat,
  requestedVoiceIds?: readonly string[],
): ShowSpeaker[] {
  const config = FORMAT_DEFAULTS[format];
  const taken = new Set<string>();

  return config.roles.map((roleConfig, index) => {
    const requested = requestedVoiceIds?.[index];
    const chosen =
      SHOW_VOICES.find((voice) => voice.voiceId === requested && !taken.has(voice.voiceId)) ??
      SHOW_VOICES.find(
        (voice) => voice.gender === roleConfig.defaultGender && !taken.has(voice.voiceId),
      ) ??
      // Every gender exhausted: any unused voice beats a duplicate, because two
      // speakers sharing a voice is the one outcome a listener cannot follow.
      SHOW_VOICES.find((voice) => !taken.has(voice.voiceId));

    // Unreachable while the roster holds more voices than the largest format has
    // roles — three today against eight — and stated rather than assumed,
    // because shrinking the roster is what would make it reachable.
    if (chosen === undefined) {
      throw new Error(`The voice roster has too few voices to cast a ${format}`);
    }

    taken.add(chosen.voiceId);
    return {
      name: chosen.name,
      voiceId: chosen.voiceId,
      voiceName: chosen.name,
      role: roleConfig.role,
    };
  });
}
