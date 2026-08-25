/**
 * The prompts that turn a series brief into an episode: its subject, its script
 * and its name.
 *
 * Three things this asks for that the version producing one-off shows did not,
 * and all three exist because a series is not a folder of unrelated recordings:
 *
 *  - **The cast is given, not invented.** Speaker names come from the series and
 *    are the roster voice names, so the model cannot produce a segment attributed
 *    to somebody with no voice. It used to invent names, which the pipeline then
 *    matched against a roster — and a model that spelled a name one way in its
 *    `speakers` list and another in a segment silently lost that segment.
 *  - **The subject is CHOSEN here, not supplied.** Asking for another episode
 *    says nothing about what it covers; the series already knows what the show
 *    is. So the model is handed the brief, every subject the show has already
 *    used, and the last few recaps, and picking the next one is the first part
 *    of the job. A request may still name a subject, and then it is simply
 *    given.
 *  - **The model is told what the previous episodes said.** Without that,
 *    episode 4 of a weekly show re-explains what episodes 1 to 3 explained,
 *    because from the model's side every episode is the first one.
 *
 * ## Breadth and detail are two different lists, at two different costs
 *
 * A recap is several sentences, so only the last few fit; a topic is one line,
 * so every episode fits. Sending recaps alone is exactly how a show repeats
 * itself at episode nine — the window holds 6, 7 and 8, and episode 2 is as
 * invisible as if it had never aired. So the prompt carries BOTH: a complete
 * list of subjects already used, and full recaps for the most recent few.
 *
 * ## An audio tag is English, in every language
 *
 * The dialogue rules used to ask for `[laughs]` in one line and forbid stage
 * directions in the next. The first line won, and a Spanish episode came back
 * carrying `[ríe]` — the model doing the reasonable thing and translating the
 * cue with the rest of the script. `[ríe]` is a tag in no model, so the voice
 * said the word aloud.
 *
 * A tag-capable model performs `[laughs]` and the tag names are ENGLISH
 * identifiers whatever language is being spoken, so the rule has to say that
 * outright: the reported failure IS the translation. The tags it names are
 * generated from `PERFORMABLE_AUDIO_TAGS` rather than written out here, because
 * a tag this prompt asks for that the code does not know would be stripped from
 * every script, silently — and two hand-maintained lists is how that happens.
 *
 * A prompt is a request, not a guarantee. `speakableText` is what makes it
 * true, per model: a tag survives to a model that performs it and is removed
 * for one that does not, and anything else in brackets is removed for both.
 *
 * ## Where a field sits in the schema decides what it is written FROM
 *
 * A model fills a JSON object in the order the schema lists it, so a `title`
 * asked for before `segments` is a title written from the brief and the
 * subject — which is the title this change exists to stop producing. `title`
 * and `recap` are therefore the LAST two fields: both are readings of the
 * finished episode, and the model has to have written it to give either.
 * `description` and `summary` stay above the segments deliberately, because
 * they are the outline the script then follows rather than a reading of it.
 */

import type { PriorEpisode } from '../../db/shows/showRepository.js';
import type { ShowFormat, ShowSpeaker } from '../../db/schema/shows.js';
import { PERFORMABLE_AUDIO_TAGS } from '../../internal/providers/lib/tts-providers.js';
import { FORMAT_DEFAULTS } from './voice-roster.js';

/**
 * The tags this prompt is allowed to ask for, rendered from the set the strip
 * enforces. Generated rather than typed out: a divergence between the two would
 * be invisible — the model would emit a tag nobody performs and `speakableText`
 * would quietly delete it.
 */
const AUDIO_TAG_LIST = [...PERFORMABLE_AUDIO_TAGS].map((tag) => `[${tag}]`).join(', ');

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
- Include natural interruptions and agreements ("Yeah", "Exactly", "Hmm")
- A performed sound goes in an audio tag, and ONLY these tags exist: ${AUDIO_TAG_LIST}
- Audio tag names are ALWAYS these ENGLISH words, no matter what language the script is written in. A Spanish line laughing is "Ya, claro... [laughs]" — NEVER "[ríe]". Do not translate a tag, do not invent one, do not add a word inside it ("[laughs nervously]" is not a tag). A tag that is not on the list above is deleted before the voice ever sees it
- Nothing else goes in brackets. No stage directions ("[he looks away]"), no tone notes, and nothing in parentheses or asterisks either. Apart from the tags above, write only what the speaker says out loud; a sound that is not part of someone's speech is its own "sfx" segment
- Each dialogue segment should be 1-4 sentences (15-60 words). Never write a single segment longer than 80 words.
- Aim for ~150 words per minute of target duration

## Sound Effects
Include sound effect segments at natural break points:
- Always start with an intro sound effect appropriate for the format
- Add transition sounds between major topic changes
- End with an outro sound effect
- Keep SFX prompts short and descriptive (e.g., "upbeat show intro jingle, 4 seconds", "smooth transition whoosh, 2 seconds")

## Output Format
Respond with ONLY valid JSON (no markdown, no explanation). Use this exact schema, with the keys in this order:

{
  "topic": "One line naming what this episode covers",
  "description": "One or two sentences describing this episode, for a podcast app's episode list",
  "summary": "A longer paragraph summarising what this episode covers",
  "segments": [
    { "type": "sfx", "speaker": "", "text": "", "sfxPrompt": "upbeat show intro jingle, 4 seconds" },
    { "type": "dialogue", "speaker": "${exampleSpeaker}", "text": "Hey everyone, welcome back to..." },
    { "type": "dialogue", "speaker": "${exampleSecond}", "text": "Thanks for having me..." },
    { "type": "sfx", "speaker": "", "text": "", "sfxPrompt": "smooth transition sound, 2 seconds" },
    { "type": "dialogue", "speaker": "${exampleSpeaker}", "text": "So let's dive into..." }
  ],
  "recap": "Two or three sentences a LATER episode can read to remember what this one said",
  "title": "The name of this episode"
}

"recap" and "title" come LAST because both describe the episode you have just written. Write the segments first, then read them back and name what is in them.

## The title
- Take it from what the episode ACTUALLY SAYS — the line that turned out to be the point of it, not the subject you set out to cover
- Six words or fewer, and it must read like a title somebody would click rather than like a summary
- Do not repeat the name of the show, do not number it, do not put it in quotes, do not end it with a full stop
- Write it in the same language as the script`;
}

/**
 * How much of one episode's subject the ledger carries.
 *
 * A ledger line is a MARKER — enough to recognise "we did that one" — not the
 * subject itself, and a request may supply two thousand characters of it. Fifty
 * of those unabridged would be most of the prompt, and would push the writing
 * guidance out of the model's attention to say nothing new.
 */
const LEDGER_TOPIC_CHARS = 140;

export interface ScriptUserPromptInput {
  /** The series' standing premise: what this show is, across every episode. */
  readonly brief: string;
  /** The show's own name, so the episode is not titled after the show. */
  readonly seriesTitle: string;
  /**
   * What THIS episode covers, or `null` to have the model choose one.
   *
   * `null` is the ordinary case: the button asks for another episode and says
   * nothing about it. A string is an owner who wanted a specific one.
   */
  readonly topic: string | null;
  /** Which episode this is, so the model can open like a first or a fifth. */
  readonly episodeNumber: number;
  /** Source material the owner supplied, if any. */
  readonly notes?: string | undefined;
  /**
   * What the earlier episodes were about, OLDEST first.
   *
   * The whole window, not the recap window: every entry contributes its subject
   * to the "already covered" list, and the most recent few that have a recap
   * contribute that too.
   */
  readonly previously: readonly PriorEpisode[];
  /** How many recaps to send in full. Every entry still contributes its subject. */
  readonly recapWindow: number;
  readonly targetDurationMinutes: number;
}

/**
 * The user prompt, carrying everything that makes this episode this episode.
 *
 * ## Both memories, and why numbering them properly matters
 *
 * Every prior episode's subject is listed, and the most recent few also get
 * their recap in full. Each line carries its REAL episode number, read from the
 * row rather than counted backwards from the current one: an episode that
 * failed leaves a gap in the numbering, and a prompt that assumed the recaps
 * were contiguous labelled them off by one from the first failure onwards. A
 * podcast that says "last week we talked about X" when it did not is worse than
 * one that never refers back at all.
 */
export function buildScriptUserPrompt(input: ScriptUserPromptInput): string {
  const targetWords = Math.round(input.targetDurationMinutes * 150);
  const covered = input.previously.filter(
    (episode): episode is PriorEpisode & { topic: string } => episode.topic !== null,
  );
  const recaps = input.previously
    .filter((episode): episode is PriorEpisode & { recap: string } => episode.recap !== null)
    .slice(-input.recapWindow);

  const parts: string[] = [
    `This show is called "${input.seriesTitle}" and it is about: ${input.brief}`,
    '',
    `Write episode ${input.episodeNumber}.`,
  ];

  if (covered.length > 0) {
    parts.push(
      '',
      '## What this show has already covered',
      'One line per episode, oldest first. These subjects are used up — do not do any of them again.',
      '',
      ...covered.map(
        (episode) =>
          `Episode ${episode.episodeNumber}: ${episode.topic.slice(0, LEDGER_TOPIC_CHARS)}`,
      ),
    );
  }

  if (recaps.length > 0) {
    parts.push(
      '',
      '## Previously on this show',
      'The most recent episodes in full. Pick up where they left off, and refer back to them naturally, the way a real host would.',
      '',
      ...recaps.map((episode) => `Episode ${episode.episodeNumber}: ${episode.recap}`),
    );
  } else if (input.episodeNumber === 1) {
    parts.push(
      '',
      'This is the FIRST episode. Introduce the show and the speakers, and set out what listeners can expect from it.',
    );
  }

  if (input.topic === null) {
    parts.push(
      '',
      '## Choosing what this episode covers',
      'Nobody has said what this one is about, so choosing it is the first part of the job. Pick ONE subject that:',
      '- sits squarely inside what this show is about, as the brief describes it;',
      '- is none of the subjects already used above, and is not a rewording of one;',
      recaps.length > 0
        ? '- follows on from where the last episodes left off — pick up a thread they opened or a question they raised, if there is one;'
        : '- is a good place for this show to start;',
      `- is narrow enough to do properly in ${input.targetDurationMinutes} minutes, rather than a survey of the whole field.`,
      '',
      'Put the subject you chose in the "topic" field, in one line, and write the episode about it.',
    );
  } else {
    parts.push(
      '',
      '## What this episode covers',
      input.topic,
      '',
      'The owner asked for this one specifically, so cover it even if it overlaps something above. Put it in the "topic" field in your own one-line wording.',
    );
  }

  parts.push(
    '',
    `Target roughly ${input.targetDurationMinutes} minutes, about ${targetWords} words of dialogue.`,
  );

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
