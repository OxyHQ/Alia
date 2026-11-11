/**
 * Relays a model's reasoning to the client as `alia.reasoning` frames.
 */
import type { Response } from 'express';
import { log } from '../logger.js';
import { sizeForLog } from './log-size.js';

export function createReasoningRelay(res: Pick<Response, 'write'>) {
  /**
   * Reasoning is relayed VERBATIM.
   *
   * A reasoning delta is a token fragment, and a token carries its own leading
   * space ("The", " user", " is"). Trimming each fragment glued the words back
   * together ("Theuser isasking") on every client, which only concatenates what
   * it is sent. Only an empty fragment is skipped.
   *
   * Two reasoning blocks of one turn (one per model step) are joined with a
   * paragraph break, announced by the block's own `reasoning-start`, so the
   * end of one step's thought never runs into the start of the next.
   */
  let reasoningBlocksSeen = 0;
  let reasoningSeparatorOwed = false;
  const writeReasoning = (text: string): void => {
    if (text === '') return;
    const content = reasoningSeparatorOwed ? `\n\n${text}` : text;
    reasoningSeparatorOwed = false;
    res.write(`event: alia.reasoning\ndata: ${JSON.stringify({ eventVersion: 1, content })}\n\n`);
    log.v1.debug({ reasoningBytes: sizeForLog(content) }, 'Reasoning chunk (provider)');
  };
  const openReasoningBlock = (): void => {
    reasoningSeparatorOwed = reasoningBlocksSeen > 0;
    reasoningBlocksSeen += 1;
  };
  return { writeReasoning, openReasoningBlock };
}
