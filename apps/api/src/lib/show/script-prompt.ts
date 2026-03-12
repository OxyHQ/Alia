/**
 * System prompt and helpers for LLM-based show script generation.
 */

import type { ShowFormat } from '../../models/show.js';
import { FORMAT_DEFAULTS } from './voice-roster.js';

const FORMAT_GUIDANCE: Record<ShowFormat, string> = {
  podcast: `Casual, friendly conversation between hosts. They share opinions, joke around, and build on each other's points. Include natural reactions like "Oh, that's interesting" or "Right, exactly."`,
  news: `Professional news broadcast style. The anchor introduces stories and the reporter adds detail and analysis. Keep a brisk pace but allow for brief back-and-forth commentary.`,
  debate: `Two speakers with opposing viewpoints, moderated by a neutral host. Each side presents arguments and rebuttals. The moderator keeps things civil and asks probing questions.`,
  interview: `A host asks thoughtful questions and the guest provides in-depth answers. The host reacts naturally and asks follow-ups. The tone is warm but informative.`,
  explainer: `A single narrator explains the topic clearly and engagingly. Use rhetorical questions, analogies, and a conversational tone to keep the listener engaged.`,
};

/**
 * Build the system prompt for show script generation.
 */
export function buildScriptSystemPrompt(format: ShowFormat): string {
  const formatConfig = FORMAT_DEFAULTS[format] || FORMAT_DEFAULTS.podcast;
  const speakerCount = formatConfig.roles.length;
  const roleList = formatConfig.roles.map(r => r.role).join(', ');
  const guidance = FORMAT_GUIDANCE[format] || FORMAT_GUIDANCE.podcast;

  return `You are a script writer for "Alia Shows". Your job is to write natural, engaging multi-speaker scripts that sound like real spoken conversation — NOT written text read aloud.

## Format: ${format}
${guidance}

## Speakers
This format uses ${speakerCount} speaker(s) with roles: ${roleList}.
Assign distinct names to each speaker. Use first names only.

## Writing Guidelines
- Write dialogue that sounds SPOKEN: use contractions, short sentences, filler words ("you know", "I mean", "right"), and natural reactions
- Vary sentence length — mix short punchy lines with longer explanations
- Include natural interruptions, agreements ("Yeah", "Exactly", "Hmm"), and laughter cues ("[laughs]"  or "[chuckles]")
- Remove any stage directions except sound effect cues — only write what the speaker actually says
- Each dialogue segment should be 1-4 sentences (15-60 words). Never write a single segment longer than 80 words.
- Aim for ~150 words per minute of target duration

## Sound Effects
Include sound effect segments at natural break points:
- Always start with an intro sound effect appropriate for the format
- Add transition sounds between major topic changes
- End with an outro sound effect
- Keep SFX prompts short and descriptive (e.g., "upbeat show intro jingle, 4 seconds", "smooth transition whoosh, 2 seconds")

## Output Format
Respond with ONLY valid JSON (no markdown, no explanation). Use this exact schema:

{
  "title": "Episode title",
  "description": "Brief episode description (1-2 sentences)",
  "speakers": ["SpeakerName1", "SpeakerName2"],
  "segments": [
    { "type": "sfx", "speaker": "", "text": "", "sfxPrompt": "upbeat show intro jingle, 4 seconds" },
    { "type": "dialogue", "speaker": "SpeakerName1", "text": "Hey everyone, welcome back to..." },
    { "type": "dialogue", "speaker": "SpeakerName2", "text": "Thanks for having me..." },
    { "type": "sfx", "speaker": "", "text": "", "sfxPrompt": "smooth transition sound, 2 seconds" },
    { "type": "dialogue", "speaker": "SpeakerName1", "text": "So let's dive into..." },
    ...
    { "type": "sfx", "speaker": "", "text": "", "sfxPrompt": "show outro jingle, 3 seconds" }
  ]
}`;
}

/**
 * Build the user prompt from topic and optional context.
 */
export function buildScriptUserPrompt(
  topic: string,
  targetDurationMinutes: number,
  sourceNotes?: string,
): string {
  const targetWords = Math.round(targetDurationMinutes * 150);

  let prompt = `Create a ${targetDurationMinutes}-minute episode about: ${topic}\n\nTarget approximately ${targetWords} words of dialogue total.`;

  if (sourceNotes) {
    prompt += `\n\nUse these notes/context as source material:\n\n${sourceNotes.slice(0, 8000)}`;
  }

  return prompt;
}
