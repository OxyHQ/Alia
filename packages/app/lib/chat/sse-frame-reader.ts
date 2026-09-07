/**
 * Reassembles an SSE byte stream into whole frames.
 *
 * ## Why this is a module rather than a few lines inside the read loop
 *
 * It used to be a few lines inside the read loop, and that is exactly how the
 * bug happened. `buffer` was correctly declared outside the loop, so a line
 * split across two `reader.read()` calls survived — but `currentEventType` was
 * declared INSIDE it and reset to `''` on every chunk. A frame is
 * `event: X\ndata: {…}\n\n` (`packages/api/src/lib/sse-emitter.ts:24`), and a
 * chunk boundary falls wherever the network puts it, so any frame split between
 * its `event:` and `data:` lines arrived with its type forgotten. It then fell
 * through to the OpenAI-shaped branch, found no `choices[0]`, and was dropped
 * without a trace.
 *
 * The events that carry the most bytes are the ones most likely to be split, so
 * this was not rare and not uniform: `alia.title`, `alia.tool_result`,
 * `alia.plan_preview`, `alia.approval_request`, `alia.agent_session` and the
 * artifact events are precisely the large ones. A title that sometimes does not
 * arrive, a canvas that sometimes does not open.
 *
 * Two pieces of state that must both outlive a chunk are easy to get half
 * right when they are loose variables in a 1 000-line hook, and hard to get
 * wrong when they are fields of one object whose whole job is to hold them.
 * That is the reason for this file, and the reason the test can feed the same
 * stream split at every byte offset — which no test of the hook could do.
 */

export interface SseFrame {
  /** The `event:` name, or `''` for an unnamed (OpenAI-shaped) frame. */
  readonly event: string;
  /** The `data:` payload, trimmed. `[DONE]` is passed through as-is. */
  readonly data: string;
}

export interface SseFrameReader {
  /** Feed one decoded chunk; get back every frame it completed. */
  push(chunk: string): SseFrame[];
}

export function createSseFrameReader(): SseFrameReader {
  let buffer = '';
  let currentEventType = '';

  return {
    push(chunk: string): SseFrame[] {
      buffer += chunk;

      const frames: SseFrame[] = [];
      const lines = buffer.split('\n');
      // The trailing element is whatever came after the last newline, which is
      // an incomplete line unless the chunk happened to end on a boundary (in
      // which case it is `''` and costs nothing to carry).
      buffer = lines.pop() ?? '';

      for (const rawLine of lines) {
        // A stream that uses CRLF leaves the CR on the end of every line;
        // `data: {…}\r` is not valid JSON.
        const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;

        if (line.startsWith('event: ')) {
          currentEventType = line.slice(7).trim();
          continue;
        }

        // A blank line closes a frame. Resetting here is what stops a `data:`
        // line in the NEXT frame inheriting this frame's event name.
        if (line === '') {
          currentEventType = '';
          continue;
        }

        if (line.startsWith('data: ')) {
          frames.push({ event: currentEventType, data: line.slice(6).trim() });
          // One `data:` line is one frame for this protocol. The event name is
          // consumed with it, so a second `data:` without its own `event:` is
          // correctly unnamed rather than inheriting.
          currentEventType = '';
          continue;
        }

        // Comments (`: keep-alive`) and any field this client does not read
        // are ignored, as the SSE specification requires.
      }

      return frames;
    },
  };
}
