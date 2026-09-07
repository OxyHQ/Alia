/**
 * Reassembles an SSE byte stream into whole frames.
 *
 * ## What it fixes
 *
 * The playground read its stream as `decoder.decode(value)` followed by
 * `chunk.split('\n')`, with no carry-over between reads. Two defects in three
 * lines, and both of them lose data silently:
 *
 *  * A frame split across two reads produced a truncated `data: {"cho`, which
 *    failed `JSON.parse` and was swallowed by an empty `catch` — so the token
 *    it carried simply never appeared in the answer. Nothing logged, nothing
 *    thrown; the reply was just missing a piece.
 *  * `decode()` without `{ stream: true }` cuts a multi-byte UTF-8 character
 *    in half at a chunk boundary and yields U+FFFD, so accents and emoji came
 *    out mangled — non-deterministically, depending on where the network split.
 *
 * ## Why the console has its own copy
 *
 * `packages/app/lib/chat/sse-frame-reader.ts` is the same reader for the same
 * wire format. It is duplicated rather than shared because the console depends
 * on neither `@alia/app` (an Expo app, not a library) nor `@alia.onl/sdk`, and
 * adding a dependency regenerates `bun.lock`, which is a separate change.
 * Consolidating the two into the SDK is the right follow-up; two correct
 * readers is still strictly better than one correct and one that drops tokens.
 */

export interface SseFrame {
  /** The `event:` name, or `''` for an unnamed (OpenAI-shaped) frame. */
  readonly event: string;
  /** The `data:` payload, trimmed. `[DONE]` is passed through as-is. */
  readonly data: string;
}

export interface SseFrameReader {
  /** Feed one decoded chunk; get back every frame it completed. */
  readonly push: (chunk: string) => Array<SseFrame>;
}

export function createSseFrameReader(): SseFrameReader {
  let buffer = '';
  let currentEventType = '';

  return {
    push(chunk: string): Array<SseFrame> {
      buffer += chunk;

      const frames: Array<SseFrame> = [];
      const lines = buffer.split('\n');
      // Whatever followed the last newline is an incomplete line — unless the
      // chunk ended on a boundary, in which case it is `''` and costs nothing.
      buffer = lines.pop() ?? '';

      for (const rawLine of lines) {
        // A CRLF stream leaves the CR on every line, and `data: {…}\r` is not
        // valid JSON.
        const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;

        if (line.startsWith('event: ')) {
          currentEventType = line.slice(7).trim();
          continue;
        }

        // A blank line closes a frame, so the next `data:` cannot inherit this
        // one's event name.
        if (line === '') {
          currentEventType = '';
          continue;
        }

        if (line.startsWith('data: ')) {
          frames.push({ event: currentEventType, data: line.slice(6).trim() });
          currentEventType = '';
          continue;
        }

        // Comments (`: keep-alive`) and unread fields are ignored, per the SSE
        // specification.
      }

      return frames;
    },
  };
}
