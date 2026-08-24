/**
 * Naming an episode, before it is written.
 *
 * ## Why the model names it HERE and not in the pipeline
 *
 * The obvious place is the script: a title written after the model knows what
 * the episode actually says is a better title. Syra makes that impossible, and
 * correctly — `POST /:id/episodes/draft` requires `title`, and
 * `ingestEpisodeAudioRequestSchema` deliberately omits it, because the ingest is
 * redeemed by a worker holding a capability rather than a person's identity and
 * renaming somebody's published episode is not a capability's business.
 *
 * So there are three options and this module is the third:
 *
 *  1. Let the script name it, and store that name only in Alia. Rejected — the
 *     two products would then disagree about the same episode's name, and
 *     Syra's is the one a listener sees.
 *  2. Use the person's raw input. Rejected as a DEFAULT: what a person types is
 *     usually a topic, not a title. "hablemos de la fotosíntesis" is a prompt.
 *  3. Ask a model for a title from the TOPIC, synchronously, while the user's
 *     token is live and before the draft is reserved.
 *
 * The cost is one small model call on `POST /shows/series/:id/episodes`. That
 * request already makes a network round trip to Syra, and series creation
 * already pays a much larger synchronous call to draw cover art, so this is not
 * a new class of latency.
 *
 * ## It is a suggestion, never a requirement
 *
 * A person who types a title keeps it — this is only consulted when they did
 * not. And every failure answers `null` so the caller falls back rather than
 * refusing to create an episode because a naming model was busy. Nothing here
 * is load-bearing; an episode with a plain name is an episode.
 *
 * Not separately charged. The episode it names reserves and settles credits of
 * its own, and the concurrency cap bounds how often this can run.
 */

import { generateText } from 'ai';
import { getAIModel, getDefaultAliaModel, resolveModel } from '../chat-core.js';
import { log } from '../logger.js';

/** Matches `show_episodes.title` and Syra's own field; a longer one is refused. */
const MAX_TITLE_LENGTH = 200;

/**
 * Short enough that a model cannot pad it into a sentence, long enough for a
 * real title. Episode names run to about six or seven words.
 */
const MAX_TITLE_TOKENS = 24;

export interface EpisodeTitleInput {
  /** The show's own name, so the episode is not titled after the show. */
  readonly seriesTitle: string;
  /** The show's standing premise. */
  readonly brief: string;
  /** What this episode covers — the person's own words. */
  readonly topic: string;
  readonly episodeNumber: number;
}

/**
 * Turn whatever a model returned into a usable title, or `null`.
 *
 * Exported because it is the part worth testing directly: every failure mode
 * here is a shape a model really produces — surrounding quotes, a leading
 * `Title:`, a trailing full stop, an explanation instead of a title — and each
 * is cheap to assert and impossible to observe through a live call.
 */
export function cleanTitle(raw: string): string | null {
  let title = raw.trim();

  // Models answer the instruction as well as obeying it, routinely.
  title = title.replace(/^(?:title|episode title)\s*:\s*/i, '');
  // Surrounding quotes of every kind a model reaches for.
  title = title.replace(/^["'“”‘’«»]+|["'“”‘’«»]+$/g, '');
  // A title is not a sentence, but keep a question mark or an exclamation —
  // those are titles ("Is anything real?"), a full stop is a sentence.
  title = title.replace(/\.+$/, '');
  title = title.trim();

  if (title === '') return null;
  // A reply this long is an explanation, not a title. Truncating it would store
  // a mangled paragraph; refusing it lets the caller fall back to the topic,
  // which is at least something the person wrote.
  if (title.length > MAX_TITLE_LENGTH) return null;
  // A newline means several candidates or a preamble. Take the first non-empty
  // line rather than the whole block.
  const [firstLine] = title.split('\n');
  const line = firstLine?.trim() ?? '';
  return line === '' ? null : line;
}

/**
 * Propose a name for this episode, or `null` if no model would.
 *
 * ONE attempt at ONE provider. The pipeline retries its script across providers
 * because a show without a script is nothing; a show without a suggested title
 * still has the person's own words to fall back on, so a retry here would spend
 * a caller's latency on something that does not need it.
 */
export async function proposeEpisodeTitle(input: EpisodeTitleInput): Promise<string | null> {
  try {
    const resolved = await resolveModel(getDefaultAliaModel(), new Set<string>());
    if (!resolved) return null;

    const result = await generateText({
      model: getAIModel(resolved, 'media'),
      messages: [
        {
          role: 'system',
          content:
            'You name podcast episodes. Reply with ONLY the title — no quotes, no ' +
            'explanation, no episode number, no punctuation at the end. Six words or ' +
            'fewer. It must read like a title a person would click, not like a summary, ' +
            'and it must not repeat the name of the show.',
        },
        {
          role: 'user',
          content: [
            `Show: ${input.seriesTitle}`,
            `About: ${input.brief.slice(0, 300)}`,
            `Episode ${input.episodeNumber} covers: ${input.topic.slice(0, 600)}`,
            '',
            'Write the title. Use the same language the topic is written in.',
          ].join('\n'),
        },
      ],
      temperature: 0.7,
      maxOutputTokens: MAX_TITLE_TOKENS,
      maxRetries: 0,
    });

    return cleanTitle(result.text ?? '');
  } catch (err: unknown) {
    // Warned, not thrown: the caller has a fallback and an episode must not fail
    // to exist because a naming model was busy.
    log.general.warn({ err }, 'Could not propose an episode title');
    return null;
  }
}
