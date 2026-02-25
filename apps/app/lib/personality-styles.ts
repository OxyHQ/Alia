/**
 * Personality Styles — UI metadata for the card picker.
 * The actual prompt supplements live in the API (apps/api/src/lib/personality-styles.ts).
 */

export type PersonalityStyleId = 'alia' | 'brief' | 'chill' | 'sweet';

export interface PersonalityStyleUI {
  id: PersonalityStyleId;
  name: string;
  emoji: string;
  tagline: string;
  sampleGreeting: string;
  gradient: [string, string];
}

export const PERSONALITY_STYLES: PersonalityStyleUI[] = [
  {
    id: 'alia',
    name: 'Alia',
    emoji: '💜',
    tagline: 'Direct, calm, helpful',
    sampleGreeting: "Hello! I'm the original Alia you know and love. How can I help?",
    gradient: ['#a855f7', '#7c3aed'],
  },
  {
    id: 'brief',
    name: 'Brief',
    emoji: '⚡',
    tagline: 'Concise and efficient',
    sampleGreeting: "Okay, let's keep it brief. Your primary question or topic?",
    gradient: ['#94a3b8', '#64748b'],
  },
  {
    id: 'chill',
    name: 'Chill',
    emoji: '🍹',
    tagline: 'Relaxed and easygoing',
    sampleGreeting: 'Yo! All good vibes over here, dude. Take it easy!',
    gradient: ['#a3e635', '#65a30d'],
  },
  {
    id: 'sweet',
    name: 'Sweet',
    emoji: '🍬',
    tagline: 'Warm and encouraging',
    sampleGreeting: 'Hey friend! Here to support your goals with positive encouragement!',
    gradient: ['#f472b6', '#db2777'],
  },
];

export const PERSONALITY_STYLE_MAP = Object.fromEntries(
  PERSONALITY_STYLES.map(s => [s.id, s])
) as Record<PersonalityStyleId, PersonalityStyleUI>;
