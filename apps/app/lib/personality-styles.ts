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
  subtitles: string[];
  gradient: [string, string];
}

export const PERSONALITY_STYLES: PersonalityStyleUI[] = [
  {
    id: 'alia',
    name: 'Alia',
    emoji: '😊',
    tagline: 'Direct, calm, helpful',
    sampleGreeting: "Hello! I'm the original Alia you know and love. How can I help?",
    subtitles: [
      'How can I help you today?',
      'What are you working on?',
      'What can I do for you?',
      'Ready to help. What do you need?',
      "Let's get started. What's up?",
      'Here whenever you need me.',
    ],
    gradient: ['#c4b5fd', '#8b5cf6'],
  },
  {
    id: 'brief',
    name: 'Brief',
    emoji: '⚡',
    tagline: 'Concise and efficient',
    sampleGreeting: "Okay, let's keep it brief. Your primary question or topic?",
    subtitles: [
      "What's on your mind?",
      'Ready when you are.',
      "Let's get to it.",
      'Go ahead.',
      'What do you need?',
      'Straight to business.',
    ],
    gradient: ['#cbd5e1', '#94a3b8'],
  },
  {
    id: 'chill',
    name: 'Chill',
    emoji: '🍹',
    tagline: 'Relaxed and easygoing',
    sampleGreeting: 'Yo! All good vibes over here, dude. Take it easy!',
    subtitles: [
      "No rush, what's on your mind?",
      "Take your time, I'm here.",
      "Easy does it. What's up?",
      'Just vibing. How can I help?',
      'All good over here. What do you need?',
      "Whenever you're ready, no pressure.",
    ],
    gradient: ['#d9f99d', '#a3e635'],
  },
  {
    id: 'sweet',
    name: 'Sweet',
    emoji: '🍬',
    tagline: 'Warm and encouraging',
    sampleGreeting: 'Hey friend! Here to support your goals with positive encouragement!',
    subtitles: [
      'So happy to see you!',
      'Ready to make today amazing!',
      'What wonderful thing are we working on?',
      "You've got this. How can I help?",
      "Let's make something great together!",
      "I'm here for you. What's on your heart?",
    ],
    gradient: ['#fbcfe8', '#f472b6'],
  },
];

export const PERSONALITY_STYLE_MAP = Object.fromEntries(
  PERSONALITY_STYLES.map(s => [s.id, s])
) as Record<PersonalityStyleId, PersonalityStyleUI>;
