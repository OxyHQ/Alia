/**
 * ElevenLabs voice roster for show generation.
 *
 * Voice IDs are for the fal-ai/elevenlabs/tts/multilingual-v2 model
 * available via DigitalOcean's async-invoke API.
 */

import type { ShowFormat, ShowSpeakerRole } from '../../models/show.js';

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
 * Default speaker configurations per show format.
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
 * Auto-assign voices from the roster to speakers based on format defaults.
 */
export function assignVoices(
  speakerNames: string[],
  format: ShowFormat,
  userVoices?: Record<string, string>,
): Array<{ name: string; voiceId: string; voiceName: string; role: ShowSpeakerRole }> {
  const formatConfig = FORMAT_DEFAULTS[format] || FORMAT_DEFAULTS.podcast;
  const usedVoiceIds = new Set<string>();

  return speakerNames.map((name, i) => {
    if (userVoices?.[name]) {
      const voice = SHOW_VOICES.find(v => v.voiceId === userVoices[name]);
      if (voice) {
        usedVoiceIds.add(voice.voiceId);
        return {
          name,
          voiceId: voice.voiceId,
          voiceName: voice.name,
          role: formatConfig.roles[i]?.role || 'guest',
        };
      }
    }

    const roleConfig = formatConfig.roles[i] || formatConfig.roles[0];
    const candidates = SHOW_VOICES.filter(
      v => v.gender === roleConfig.defaultGender && !usedVoiceIds.has(v.voiceId),
    );
    const voice = candidates[0] || SHOW_VOICES.find(v => !usedVoiceIds.has(v.voiceId)) || SHOW_VOICES[0];
    usedVoiceIds.add(voice.voiceId);

    return {
      name,
      voiceId: voice.voiceId,
      voiceName: voice.name,
      role: roleConfig.role,
    };
  });
}
