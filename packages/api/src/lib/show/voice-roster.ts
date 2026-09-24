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
 * ## A voice id is what Kaana's speech endpoint accepts, and nothing else
 *
 * Speech goes Alia -> Oxy -> Kaana (`synthesize-speech.ts`), and Kaana refuses
 * any `voice` outside its reviewed set with `invalid speech.voice` — before a
 * byte is synthesised. So `voiceId` here is exactly one of those slugs
 * (`eve`, `ara`, `rex`, `leo`, `sal`), and the roster has as many voices as the
 * endpoint has: five. `name` and `description` are Alia's own product labels;
 * the listener hears `name` introduced on air, so it never changes for a voice
 * already in use.
 *
 * ## Series cast before the switch still name the retired ids
 *
 * `show_series.speakers` is `jsonb`, and every series created before this
 * roster stores voice ids the endpoint no longer takes. They are translated
 * where they are SPOKEN (`speakingVoices`), not rewritten in the table: the
 * speaker's name — the one thing a listener knows — is kept, the old id is an
 * implementation detail nothing else reads, and a read-time map has no
 * migration phase to get wrong.
 */

import type { ShowFormat, ShowSpeaker, ShowSpeakerRole } from '../../db/schema/shows.js';

export interface ShowVoice {
  voiceId: string;
  name: string;
  gender: 'male' | 'female' | 'neutral';
  accent: string;
  description: string;
}

/**
 * Order is policy: `buildSeriesCast` takes the FIRST unused voice of a role's
 * gender, so Marcus and Sarah remain the default hosts they always were.
 */
export const SHOW_VOICES: readonly ShowVoice[] = [
  { voiceId: 'rex', name: 'Marcus', gender: 'male', accent: 'Neutral', description: 'Confident, clear male voice' },
  { voiceId: 'leo', name: 'Adam', gender: 'male', accent: 'Neutral', description: 'Deep, authoritative male voice' },
  { voiceId: 'ara', name: 'Sarah', gender: 'female', accent: 'Neutral', description: 'Warm, friendly female voice' },
  { voiceId: 'eve', name: 'Emily', gender: 'female', accent: 'Neutral', description: 'Bright, energetic female voice' },
  { voiceId: 'sal', name: 'Sam', gender: 'neutral', accent: 'Neutral', description: 'Smooth, balanced voice' },
];

/**
 * The retired roster's ids, each to the current voice closest in character.
 * A `Map`, because the key is whatever a stored row says — `constructor` must
 * not answer from `Object.prototype`.
 *
 * Several old voices share a new one (eight became five), which is why
 * `speakingVoices` still de-duplicates after translating: a series cast as
 * Adam and Arnold must not end up with both hosts speaking as one voice.
 */
export const LEGACY_VOICE_IDS: ReadonlyMap<string, string> = new Map([
  ['kPzsL2i3teMYv0FxEYQ6', 'rex'], // Marcus
  ['pNInz6obpgDQGcFmaJgB', 'leo'], // Adam
  ['ErXwobaYiN019PkySvjV', 'sal'], // Antoni
  ['VR6AewLTigWG4xSOukaG', 'leo'], // Arnold
  ['EXAVITQu4vr4xnSDxMaL', 'ara'], // Sarah
  ['21m00Tcm4TlvDq8ikWAM', 'ara'], // Rachel
  ['MF3mGyEYCl7XYWbV9V6O', 'eve'], // Emily
  ['AZnzlk1XvdvUeBnXmlld', 'eve'], // Domi
]);

const VOICE_BY_ID = new Map(SHOW_VOICES.map((voice) => [voice.voiceId, voice]));

/** A current voice for `voiceId`, translating a retired id; `undefined` if neither. */
export function currentVoice(voiceId: string | undefined): ShowVoice | undefined {
  if (voiceId === undefined) return undefined;
  return VOICE_BY_ID.get(voiceId) ?? VOICE_BY_ID.get(LEGACY_VOICE_IDS.get(voiceId) ?? '');
}

/**
 * The voice each speaker of a STORED cast is synthesised with, by speaker name.
 *
 * Current ids pass through; retired ids are translated; an id that is neither
 * falls back to the roster voice sharing the speaker's `voiceName`, then to any
 * unused voice. Whatever the source, no two speakers share a voice while the
 * roster has one left — a clash is re-cast to an unused voice of the same
 * gender first, so a two-host show always has two distinct voices.
 */
export function speakingVoices(cast: readonly ShowSpeaker[]): Map<string, string> {
  const taken = new Set<string>();
  const voices = new Map<string, string>();

  for (const speaker of cast) {
    const wanted =
      currentVoice(speaker.voiceId) ?? SHOW_VOICES.find((voice) => voice.name === speaker.voiceName);
    const chosen =
      (wanted !== undefined && !taken.has(wanted.voiceId) ? wanted : undefined) ??
      SHOW_VOICES.find(
        (voice) => wanted !== undefined && voice.gender === wanted.gender && !taken.has(voice.voiceId),
      ) ??
      SHOW_VOICES.find((voice) => !taken.has(voice.voiceId)) ??
      // A cast larger than the roster: sharing a voice beats a silent speaker.
      wanted ??
      SHOW_VOICES[0];
    if (chosen === undefined) continue;
    taken.add(chosen.voiceId);
    voices.set(speaker.name, chosen.voiceId);
  }

  return voices;
}

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
 * ignored rather than rejected (a retired id is translated first) — the caller gets a complete cast either way,
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
    const requestedVoice = currentVoice(requested);
    const chosen =
      (requestedVoice !== undefined && !taken.has(requestedVoice.voiceId) ? requestedVoice : undefined) ??
      SHOW_VOICES.find(
        (voice) => voice.gender === roleConfig.defaultGender && !taken.has(voice.voiceId),
      ) ??
      // Every gender exhausted: any unused voice beats a duplicate, because two
      // speakers sharing a voice is the one outcome a listener cannot follow.
      SHOW_VOICES.find((voice) => !taken.has(voice.voiceId));

    // Unreachable while the roster holds more voices than the largest format has
    // roles — three today against five — and stated rather than assumed,
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
