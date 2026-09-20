import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  MAX_ATTACHMENT_BYTES,
  classifyIntake,
  dragCarriesFiles,
  intakeKind,
  nextDragDepth,
  readFraction,
} from '../attachment-intake';

/**
 * The rules a file passes on its way into the composer, and the count that
 * keeps a drop affordance still.
 *
 * Both are arithmetic guarding something visible — a tile that should not
 * exist, an overlay that strobes — and neither needs a composer, a browser or
 * a staged drag to be checked.
 */

describe('what the composer will take', () => {
  it('refuses a zero-byte file, because that is how a dropped FOLDER arrives', () => {
    // Not pedantry about empty files: every browser represents a dropped
    // directory as a `File` of size 0 with no type, and accepting one puts a
    // tile in the strip for contents the composer will never have.
    expect(classifyIntake({ name: 'Pictures', mimeType: '', size: 0 })).toEqual({
      accepted: false,
      refusal: 'empty',
    });
  });

  it('refuses a file past the cap, and takes one exactly at it', () => {
    const at = classifyIntake({
      name: 'big.png',
      mimeType: 'image/png',
      size: MAX_ATTACHMENT_BYTES,
    });
    const over = classifyIntake({
      name: 'bigger.png',
      mimeType: 'image/png',
      size: MAX_ATTACHMENT_BYTES + 1,
    });

    // The boundary itself, both sides — a cap written with the wrong
    // comparison passes every test that only checks a file ten times too big.
    expect(at).toEqual({ accepted: true, kind: 'image' });
    expect(over).toEqual({ accepted: false, refusal: 'too-large' });
  });

  it('reads a picture by name when the OS gave no type at all', () => {
    // A drag fills `type` from the OS and it arrives empty often enough to
    // matter. Filed as a document, a `.png` is never inlined into the request:
    // `buildMessageContent` keeps only `type === 'image'`.
    expect(intakeKind({ name: 'holiday.PNG', mimeType: '', size: 10 })).toBe('image');
    expect(intakeKind({ name: 'notes.pdf', mimeType: '', size: 10 })).toBe('document');
    // And the browser's answer still wins where it has one.
    expect(intakeKind({ name: 'no-extension', mimeType: 'image/webp', size: 10 })).toBe(
      'image',
    );
  });
});

describe('the drag count', () => {
  it('stays up when the pointer crosses a child of the composer', () => {
    // The whole reason the count exists. Moving from the bar onto the textarea
    // inside it fires `dragenter` (textarea) and THEN `dragleave` (bar), in
    // that order — a boolean set by enter and cleared by leave ends this
    // sequence switched off while the pointer is still over the composer.
    let depth = 0;
    depth = nextDragDepth(depth, 'enter'); // onto the bar
    expect(depth).toBeGreaterThan(0);

    depth = nextDragDepth(depth, 'enter'); // onto the textarea within it
    depth = nextDragDepth(depth, 'leave'); // and off the bar itself

    expect(depth).toBeGreaterThan(0);
  });

  it('only clears once the pointer has left everything', () => {
    let depth = 0;
    for (const step of ['enter', 'enter', 'leave', 'leave'] as const) {
      depth = nextDragDepth(depth, step);
    }
    expect(depth).toBe(0);
  });

  it('clears on drop, which sends no matching dragleave', () => {
    // A decrement here leaves the count at one and pins the overlay over the
    // composer for the rest of the session.
    let depth = nextDragDepth(nextDragDepth(0, 'enter'), 'enter');
    expect(nextDragDepth(depth, 'drop')).toBe(0);
  });

  it('never goes negative on a leave it never saw the enter for', () => {
    // A drag begun before the listeners were attached. Unclamped, the overlay
    // would then need two full entries before it reappeared.
    expect(nextDragDepth(0, 'leave')).toBe(0);
    expect(nextDragDepth(nextDragDepth(0, 'leave'), 'enter')).toBe(1);
  });

  it('engages for files and ignores dragged text', () => {
    expect(dragCarriesFiles(['Files'])).toBe(true);
    expect(dragCarriesFiles(['text/plain', 'text/uri-list'])).toBe(false);
    expect(dragCarriesFiles(undefined)).toBe(false);
  });
});

describe('how far a read has got', () => {
  it('is a fraction when the browser measured it', () => {
    expect(readFraction({ lengthComputable: true, loaded: 25, total: 100 })).toBe(0.25);
  });

  it('is null — not zero, not NaN — when it did not', () => {
    // `lengthComputable: false` comes with `total: 0`, and the division at a
    // call site would yield NaN or Infinity. Both render as SOMETHING once
    // handed to a bar, and that something is invented. #608 §7 forbids it.
    expect(readFraction({ lengthComputable: false, loaded: 0, total: 0 })).toBeNull();
    expect(readFraction({ lengthComputable: true, loaded: 5, total: 0 })).toBeNull();
    expect(readFraction({ lengthComputable: true, loaded: Number.NaN, total: 8 })).toBeNull();
  });

  it('never reports more than finished, whatever the browser claims', () => {
    expect(readFraction({ lengthComputable: true, loaded: 120, total: 100 })).toBe(1);
  });
});

describe('the module itself', () => {
  const source = readFileSync(
    fileURLToPath(new URL('../attachment-intake.ts', import.meta.url)),
    'utf8',
  )
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/[^\n]*/g, '');

  it('grows no timer and no randomness, which is how Bloom’s ring is drawn', () => {
    // `composer-panel/use-attachment-queue.ts` advances its ring on a 50ms
    // tick by `step * (0.55 + Math.random() * 0.9)` and fires
    // `onUploadComplete` whether or not a byte moved. A percentage in Alia has
    // to come from a `ProgressEvent`, so neither of those may appear here.
    expect(source).not.toContain('Math.random');
    expect(source).not.toContain('setInterval');
    expect(source).not.toContain('setTimeout');
    // Nor may this file reach a renderer or a store — the rule `composer-state.ts`
    // next door states and the reason either of them is testable.
    expect(source).not.toContain('react-native');
    expect(source).not.toContain('useStore');
  });
});
