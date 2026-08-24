/**
 * The prompts that turn a series brief and an episode topic into a script.
 *
 * Two changes from the version that produced one-off shows, and both exist
 * because a series is not a folder of unrelated recordings:
 *
 *  - **The cast is given, not invented.** Speaker names come from the series and
 *    are the roster voice names, so the model cannot produce a segment attributed
 *    to somebody with no voice. It used to invent names, which the pipeline then
 *    matched against a roster — and a model that spelled a name one way in its
 *    `speakers` list and another in a segment silently lost that segment.
 *  - **The model is told what the previous episodes said.** Without that,
 *    episode 4 of a weekly show re-explains what episodes 1 to 3 explained,
 *    because from the model's side every episode is the first one.
 *
 * The model does NOT choose the title. Syra fixes an episode's title when the
 * draft is reserved and refuses to let the ingest change it, so a
 * model-authored title could never reach the published episode — it would only
 * make Alia and Syra disagree about the same episode's name.
 */

import type { ShowFormat, ShowSpeaker } from '../../db/schema/shows.js';
import { FORMAT_DEFAULTS } from './voice-roster.js';

const FORMAT_GUIDANCE: Record<ShowFormat, string> = {
  podcast: `Casual, friendly conversation between hosts. They share opinions, joke around, and build on each other's points. Include natural reactions like "Oh, that's interesting" or "Right, exactly."`,
  news: `Professional news broadcast style. The anchor introduces stories and the reporter adds detail and analysis. Keep a brisk pace but allow for brief back-and-forth commentary.`,
  debate: `Two speakers with opposing viewpoints, moderated by a neutral host. Each side presents arguments and rebuttals. The moderator keeps things civil and asks probing questions.`,
  interview: `A host asks thoughtful questions and the guest provides in-depth answers. The host reacts naturally and asks follow-ups. The tone is warm but informative.`,
  explainer: `A single narrator explains the topic clearly and engagingly. Use rhetorical questions, analogies, and a conversational tone to keep the listener engaged.`,
};

/**
 * The system prompt, built around a cast that already exists.
 *
 * The speaker list is stated as a closed set and repeated in the schema example,
 * because a model given names once at the top and an abstract schema below will
 * fill the schema with the schema's placeholder names.
 */
export function buildScriptSystemPrompt(format: ShowFormat, speakers: readonly ShowSpeaker[]): string {
  const guidance = FORMAT_GUIDANCE[format];
  const roster = speakers.map((speaker) => `- ${speaker.name} (${speaker.role})`).join('\n');
  const [first, second] = speakers;
  const exampleSpeaker = first?.name ?? FORMAT_DEFAULTS[format].roles[0]?.role ?? 'Host';
  const exampleSecond = second?.name ?? exampleSpeaker;

  return `You are a script writer for "Alia Shows". Your job is to write natural, engaging multi-speaker scripts that sound like real spoken conversation — NOT written text read aloud.

## Format: ${format}
${guidance}

## Speakers — use these EXACT names and no others
${roster}

Every dialogue segment's "speaker" must be one of the names above, spelled exactly as written. Do not introduce a new speaker, do not rename one, and do not use a role name in place of a person's name.

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
  "description": "One or two sentences describing this episode, for a podcast app's episode list",
  "summary": "A longer paragraph summarising what this episode covers",
  "recap": "Two or three sentences a LATER episode can read to remember what this one said",
  "segments": [
    { "type": "sfx", "speaker": "", "text": "", "sfxPrompt": "upbeat show intro jingle, 4 seconds" },
    { "type": "dialogue", "speaker": "${exampleSpeaker}", "text": "Hey everyone, welcome back to..." },
    { "type": "dialogue", "speaker": "${exampleSecond}", "text": "Thanks for having me..." },
    { "type": "sfx", "speaker": "", "text": "", "sfxPrompt": "smooth transition sound, 2 seconds" },
    { "type": "dialogue", "speaker": "${exampleSpeaker}", "text": "So let's dive into..." }
  ]
}

The title is NOT yours to choose and is not in the schema — it is already set.`;
}

export interface ScriptUserPromptInput {
  /** The series' standing premise: what this show is, across every episode. */
  readonly brief: string;
  /** The title this episode already has. */
  readonly title: string;
  /** What THIS episode covers. */
  readonly topic: string;
  /** Which episode this is, so the model can open like a first or a fifth. */
  readonly episodeNumber: number;
  /** Source material the owner supplied, if any. */
  readonly notes?: string | undefined;
  /** Recaps of the preceding episodes, OLDEST first. */
  readonly previousRecaps: readonly string[];
  readonly targetDurationMinutes: number;
}

/**
 * The user prompt, carrying everything that makes this episode this episode.
 *
 * The recaps are numbered relative to the current episode rather than listed
 * flat, so "the previous episode" is unambiguous — a model handed three
 * paragraphs with no ordering will reference the wrong one about a third of the
 * time, and a podcast that says "last week we talked about X" when it did not is
 * worse than one that never refers back at all.
 */
export function buildScriptUserPrompt(input: ScriptUserPromptInput): string {
  const targetWords = Math.round(input.targetDurationMinutes * 150);
  const parts: string[] = [
    `This show is about: ${input.brief}`,
    '',
    `Write episode ${input.episodeNumber}, titled "${input.title}".`,
    `This episode covers: ${input.topic}`,
    '',
    `Target roughly ${input.targetDurationMinutes} minutes, about ${targetWords} words of dialogue.`,
  ];

  if (input.previousRecaps.length > 0) {
    parts.push(
      '',
      '## Previously on this show',
      'These are the episodes immediately before this one, oldest first. Do not repeat what they already covered. You may refer back to them naturally, the way a real host would.',
      '',
      ...input.previousRecaps.map((recap, index) => {
        const number = input.episodeNumber - input.previousRecaps.length + index;
        return `Episode ${number}: ${recap}`;
      }),
    );
  } else if (input.episodeNumber === 1) {
    parts.push(
      '',
      'This is the FIRST episode. Introduce the show and the speakers, and set out what listeners can expect from it.',
    );
  }

  if (input.notes !== undefined && input.notes.trim() !== '') {
    parts.push(
      '',
      '## Source material',
      // Bounded, because this is the owner's paste buffer and an unbounded one
      // pushes the guidance above out of the model's attention entirely.
      input.notes.slice(0, 8000),
    );
  }

  return parts.join('\n');
}
