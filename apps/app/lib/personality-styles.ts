/**
 * Personality Styles — UI metadata for the card picker.
 * The actual prompt supplements live in the API (apps/api/src/lib/personality-styles.ts).
 */

export type PersonalityStyleId = 'alia' | 'brief' | 'chill' | 'sweet' | 'witty' | 'mentor' | 'bold';

export interface PersonalityStyleUI {
  id: PersonalityStyleId;
  name: string;
  /** Lucide icon name */
  icon: string;
  /** Primary accent color for the icon circle */
  color: string;
  tagline: string;
  sampleGreeting: string;
  subtitles: string[];
  gradient: [string, string];
  popular?: boolean;
}

export const PERSONALITY_STYLES: PersonalityStyleUI[] = [
  {
    id: 'alia',
    name: 'Alia',
    icon: 'Heart',
    color: '#8b5cf6',
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
    popular: true,
  },
  {
    id: 'brief',
    name: 'Brief',
    icon: 'Zap',
    color: '#94a3b8',
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
    icon: 'Coffee',
    color: '#a3e635',
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
    icon: 'Sparkles',
    color: '#f472b6',
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
  {
    id: 'witty',
    name: 'Witty',
    icon: 'Lightbulb',
    color: '#f59e0b',
    tagline: 'Clever and playful',
    sampleGreeting: "Well, well — looks like we've got something interesting to figure out.",
    subtitles: [
      "Plot twist: I'm here to help.",
      'Another day, another fascinating problem.',
      "Let's make this interesting.",
      'Ready to connect some dots?',
      "I've got thoughts. You've got questions. Let's go.",
      'Consider me intrigued.',
    ],
    gradient: ['#fde68a', '#f59e0b'],
  },
  {
    id: 'mentor',
    name: 'Mentor',
    icon: 'GraduationCap',
    color: '#3b82f6',
    tagline: 'Thoughtful and guiding',
    sampleGreeting: "Good question. Let's think through this together — what have you tried so far?",
    subtitles: [
      "Let's break this down together.",
      'What are you trying to achieve?',
      "Walk me through what you've got so far.",
      "There's a great way to think about this.",
      'Consider the bigger picture here.',
      "Let's start with the fundamentals.",
    ],
    gradient: ['#bfdbfe', '#3b82f6'],
  },
  {
    id: 'bold',
    name: 'Bold',
    icon: 'Flame',
    color: '#ef4444',
    tagline: 'Confident and direct',
    sampleGreeting: "Let's cut to it. Tell me what you need and I'll give you my honest take.",
    subtitles: [
      "Here's the deal.",
      "Don't hold back. What do you need?",
      "Let's get straight to it.",
      "I'll give it to you straight.",
      'No sugarcoating. What are we solving?',
      'Ready to make a decision? Let me help.',
    ],
    gradient: ['#fecaca', '#ef4444'],
  },
];

export const PERSONALITY_STYLE_MAP = Object.fromEntries(
  PERSONALITY_STYLES.map(s => [s.id, s])
) as Record<PersonalityStyleId, PersonalityStyleUI>;
