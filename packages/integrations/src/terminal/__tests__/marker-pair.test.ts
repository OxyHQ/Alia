/**
 * The completion markers `runCommand` waits for.
 *
 * ## The defect
 *
 * A PTY echoes its input back before the shell has run any of it. The previous
 * implementation wrote `${command}\necho "__CMD_DONE_…__"` and resolved on the
 * first appearance of that marker in the stream — which was its own echo of
 * the `echo` line, arriving before the command had produced a single byte. It
 * then returned `lines.slice(0, markerIdx)`, i.e. the echoed command text.
 *
 * So `POST /terminal/session/:id/run` returned the command instead of its
 * output. For every command, not as an edge case, and with no error anywhere.
 *
 * ## The property under test
 *
 * The literal is split in the SOURCE — `"__CMD" "_START_x__"` — so the shell
 * concatenates it into a contiguous marker when it PRINTS, while the echoed
 * line keeps the quotes between the halves. A search for the contiguous form
 * therefore matches the shell's output and cannot match the echo.
 *
 * That is a property of the strings themselves, which is why it is tested
 * here rather than against a real PTY: spawning a shell to prove a substring
 * relation would make a fast, exact test slow and platform-dependent, and
 * would not check the case that matters more — that the echoed form does NOT
 * contain the marker.
 */

import { describe, expect, it } from 'vitest';

import { markerPair } from '../manager';

describe('the echoed marker cannot be mistaken for the printed one', () => {
  const { start, end, startEcho, endEcho } = markerPair('abc123');

  it('the echoed source does not contain the contiguous marker', () => {
    // This is the whole fix. If this ever fails, `runCommand` resolves on the
    // terminal's echo again and returns the command instead of its output.
    expect(startEcho).not.toContain(start);
    expect(endEcho).not.toContain(end);
  });

  it('what the shell prints IS the contiguous marker', () => {
    // The shell concatenates adjacent quoted strings, so `echo "__CMD""_START_abc123__"`
    // writes `__CMD_START_abc123__` on its own line.
    expect(startEcho.replace(/"/g, '')).toContain(start);
    expect(endEcho.replace(/"/g, '')).toContain(end);
  });

  it('start and end are distinguishable from each other', () => {
    expect(start).not.toBe(end);
    expect(startEcho).not.toContain(end);
    expect(endEcho).not.toContain(start);
  });

  it('gives different ids different markers', () => {
    expect(markerPair('one').start).not.toBe(markerPair('two').start);
  });

  it('extracts exactly the text between the printed markers', () => {
    // The shape of a real session: the tty echoes the whole input first, then
    // the shell runs it. Anything before `start` is echo; anything after `end`
    // belongs to whatever runs next.
    const stream = [
      startEcho,
      'ls -1',
      endEcho,
      start,
      'alpha.txt',
      'beta.txt',
      end,
      'the-next-prompt$ ',
    ].join('\r\n');

    const startIndex = stream.indexOf(start);
    const endIndex = stream.indexOf(end);
    const body = stream.slice(startIndex + start.length, endIndex).trim();

    expect(body).toBe('alpha.txt\r\nbeta.txt');
    // The pre-fix reader took everything up to the FIRST marker occurrence,
    // which in this same stream is the echoed command block.
    expect(body).not.toContain('ls -1');
  });
});
