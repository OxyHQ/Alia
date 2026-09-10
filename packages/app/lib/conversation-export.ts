import type { Message } from '@/lib/hooks/use-conversations';
import { extractSources } from '@/lib/thought-utils';

/**
 * A conversation as a Markdown document.
 *
 * Pure, and deliberately so: the header's menu item is the only thing that
 * asks for this, and what it hands over is the same `messages` array the
 * screen is streaming into. Everything about DELIVERY — a download on web, the
 * share sheet on a phone — lives in `conversation-share.ts`, so this module can
 * be tested against a string and nothing else.
 *
 * ## What is kept and what is left out
 *
 *  - Roles, as headings. The person is `## You` (or the translation handed in)
 *    and the answer is `## Alia`, or the agent's own name when the thread is
 *    with one, or the delegated agent's name on a turn that came from one.
 *  - The text, verbatim. An answer is already Markdown — fenced code blocks,
 *    lists, tables — so it is pasted as it is rather than re-rendered, which is
 *    what makes a code block survive the round trip.
 *  - Images, as image links. A multi-part user turn carries them as
 *    `image_url` parts, and Markdown has a spelling for exactly that.
 *  - Sources, as a list of links under the answer that used them. They are
 *    read out of `toolInvocations` — the same jsonb the message is stored with
 *    — by the same `extractSources` the thread shows them from, so the export
 *    cites what the screen cites.
 *  - Thinking is OMITTED. It is the model's scratchpad, shown in a side panel
 *    on request; a document of the conversation is a document of what was
 *    said.
 *  - `system` turns are omitted too: they are not part of the exchange.
 */
export interface ConversationExportOptions {
  /** The conversation's title, as the document's heading. */
  title: string;
  messages: readonly Message[];
  /** When the document was made — the header states it. */
  exportedAt: Date;
  /** The name Alia answers under here; the heading for assistant turns. */
  assistantName?: string;
  /** The heading for the person's own turns, in their language. */
  userLabel?: string;
}

const DEFAULT_ASSISTANT = 'Alia';
const DEFAULT_USER = 'You';

/** `YYYY-MM-DD` in the reader's own timezone, not the UTC one `toISOString` gives. */
export function localDate(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/**
 * The body of one message as Markdown: its text, then its images.
 *
 * A part the exporter does not know is dropped rather than stringified — an
 * unknown part in a saved message is a shape from a later version of the app,
 * and `[object Object]` in the middle of a document helps nobody.
 */
function messageBody(content: Message['content']): string {
  if (typeof content === 'string') return content.trim();
  if (!Array.isArray(content)) return '';

  const text: string[] = [];
  const images: string[] = [];
  for (const part of content) {
    if (part.type === 'text' && typeof part.text === 'string') {
      text.push(part.text);
    } else if (part.type === 'image_url') {
      const url = (part.image_url as { url?: unknown } | undefined)?.url;
      if (typeof url === 'string' && url !== '') images.push(url);
    }
  }

  const lines = [text.join('').trim()];
  images.forEach((url, i) => lines.push(`![Image ${i + 1}](${url})`));
  return lines.filter((line) => line !== '').join('\n\n');
}

/** The heading a turn is written under. */
function heading(message: Message, assistantName: string, userLabel: string): string {
  if (message.role === 'user') return userLabel;
  return message.agentInfo?.name || assistantName;
}

export function buildConversationMarkdown({
  title,
  messages,
  exportedAt,
  assistantName = DEFAULT_ASSISTANT,
  userLabel = DEFAULT_USER,
}: ConversationExportOptions): string {
  const sections: string[] = [`# ${title.trim() || DEFAULT_ASSISTANT}`, `_Exported ${localDate(exportedAt)}_`];

  for (const message of messages) {
    if (message.role !== 'user' && message.role !== 'assistant') continue;

    const body = messageBody(message.content);
    const sources = message.role === 'assistant' ? extractSources(message.toolInvocations) : [];
    // An assistant placeholder that never got its answer, or a turn whose
    // only content was a part the exporter dropped: nothing to write under
    // the heading, so no heading.
    if (body === '' && sources.length === 0) continue;

    const parts = [`## ${heading(message, assistantName, userLabel)}`];
    if (body !== '') parts.push(body);
    if (sources.length > 0) {
      parts.push(['### Sources', ...sources.map((s) => `- [${s.title}](${s.url})`)].join('\n'));
    }
    sections.push(parts.join('\n\n'));
  }

  return `${sections.join('\n\n')}\n`;
}

/**
 * A file name for the document: the title, made safe for a file system, with
 * the date so two exports of one thread do not overwrite each other.
 */
export function exportFilename(title: string, exportedAt: Date): string {
  // NFD splits an accented letter into letter + combining mark, and the range
  // is the combining marks block, spelled as a range and not as `\p{M}`: a
  // property escape throws at RUNTIME on Hermes, where this code runs.
  const slug = title
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  return `${slug || 'conversation'}-${localDate(exportedAt)}.md`;
}
