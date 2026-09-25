import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  useAttachmentIntake,
  type AttachmentIntake,
  type ReadHandlers,
  type StartRead,
} from '../use-attachment-intake';
import { MAX_ATTACHMENT_BYTES } from '@/features/chat/model/attachment-intake';
import type { Attachment } from '../types';

/**
 * The queue between "the user handed us a file" and "the strip has it".
 *
 * Everything worth pinning here is a lifecycle, not a render: whether a cancel
 * reaches the reader that is running NOW, whether a retry re-reads the same
 * file, whether the bytes are let go of. So the reader is injected and driven
 * by hand — a test that cannot step a read cannot tell a cancel that aborts
 * from a cancel that hides a row, which is exactly the distinction #608 asks
 * for.
 */

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

/** A `File` in everything the intake actually reads off one. */
const file = (over: Partial<File> = {}): File =>
  ({
    name: 'photo.png',
    type: 'image/png',
    size: 1024,
    ...over,
  }) as File;

type StartedRead = {
  file: Blob;
  handlers: ReadHandlers;
  abort: ReturnType<typeof vi.fn>;
};

let renderer: ReactTestRenderer | null = null;
let started: StartedRead[] = [];
let added: Attachment[] = [];
let intake: AttachmentIntake;

const startRead: StartRead = (source, handlers) => {
  const abort = vi.fn();
  started.push({ file: source, handlers, abort });
  return { abort };
};

function Probe() {
  intake = useAttachmentIntake({
    addAttachment: (attachment) => added.push(attachment),
    startRead,
  });
  return null;
}

function mount() {
  act(() => {
    renderer = create(<Probe />);
  });
}

beforeEach(() => {
  started = [];
  added = [];
  mount();
});

afterEach(() => {
  if (renderer !== null) {
    act(() => renderer?.unmount());
    renderer = null;
  }
  vi.restoreAllMocks();
});

describe('taking a file in', () => {
  it('queues a picture as unmeasured, not as zero', () => {
    act(() => intake.accept([file()]));

    expect(intake.items).toHaveLength(1);
    expect(intake.items[0].status).toBe('reading');
    // `null`, not `0`. Zero is a claim that the read has started and moved
    // nothing; null is the truth, which is that nothing has been reported yet
    // — and it is what makes the tile show indeterminate activity instead of
    // an empty bar that looks stuck.
    expect(intake.items[0].fraction).toBeNull();
    // Not an attachment yet: it has no `uri`, and `buildMessageContent` drops
    // exactly those.
    expect(added).toHaveLength(0);
  });

  it('carries the measured fraction through, and only the measured one', () => {
    act(() => intake.accept([file()]));

    act(() => started[0].handlers.onProgress(0.4));
    expect(intake.items[0].fraction).toBe(0.4);

    act(() => started[0].handlers.onProgress(null));
    expect(intake.items[0].fraction).toBeNull();
  });

  it('hands over an attachment only once the bytes are in it', () => {
    act(() => intake.accept([file({ name: 'holiday.png', size: 4096 })]));
    act(() => started[0].handlers.onDone('data:image/png;base64,AAAA'));

    expect(intake.items).toHaveLength(0);
    expect(added).toEqual([
      expect.objectContaining({
        uri: 'data:image/png;base64,AAAA',
        type: 'image',
        name: 'holiday.png',
        size: 4096,
        mimeType: 'image/png',
      }),
    ]);
  });

  it('reports a file it will not take, by name, and reads nothing', () => {
    act(() =>
      intake.accept([
        file({ name: 'enormous.png', size: MAX_ATTACHMENT_BYTES + 1 }),
        file({ name: 'Pictures', type: '', size: 0 }),
        file({ name: 'fine.png' }),
      ]),
    );

    // Named, and standing beside the one that worked. Silence here is the
    // worst outcome of the three: the message goes without the picture and
    // looks to the user like it went with it.
    expect(
      intake.items
        .filter((item) => item.status === 'refused')
        .map((item) => [item.name, item.refusal]),
    ).toEqual([
      ['enormous.png', 'too-large'],
      ['Pictures', 'empty'],
    ]);
    // Refused, so never read — and never counted as work in progress, or the
    // send button would stay shut until the row was dismissed.
    expect(started).toHaveLength(1);
    expect(intake.isBusy).toBe(true);
    act(() => started[0].handlers.onDone('data:image/png;base64,DDDD'));
    expect(intake.isBusy).toBe(false);
  });

  it('lets a refusal be dismissed, and offers it no retry', () => {
    act(() => intake.accept([file({ name: 'Pictures', type: '', size: 0 })]));
    const id = intake.items[0].id;

    // The same 30 MB file read again is the same 30 MB. A retry here would
    // re-run a decision already made — a control wired to nothing.
    act(() => intake.retry(id));
    expect(started).toHaveLength(0);

    act(() => intake.dismiss(id));
    expect(intake.items).toHaveLength(0);
  });

  it('takes a document straight through, with no read to show progress for', () => {
    const created = vi.fn(() => 'blob:alia/doc-1');
    vi.stubGlobal('URL', { createObjectURL: created, revokeObjectURL: vi.fn() });

    act(() => intake.accept([file({ name: 'report.pdf', type: 'application/pdf' })]));

    // `buildMessageContent` keeps only images, so a document's bytes go
    // nowhere — reading them would be a progress bar over work whose result
    // nobody consumes.
    expect(started).toHaveLength(0);
    expect(intake.items).toHaveLength(0);
    expect(added[0]).toEqual(
      expect.objectContaining({ uri: 'blob:alia/doc-1', type: 'document' }),
    );
  });
});

describe('cancel', () => {
  it('aborts the read rather than hiding the row', () => {
    act(() => intake.accept([file()]));
    const id = intake.items[0].id;

    act(() => intake.cancel(id));

    // The assertion that separates a real cancel from a cosmetic one: the
    // reader was told to stop. Without it the read runs to completion holding
    // the whole file, and only the tile went away.
    expect(started[0].abort).toHaveBeenCalledTimes(1);
    expect(intake.items).toHaveLength(0);
  });

  it('leaves nothing behind that a late completion could resurrect', () => {
    act(() => intake.accept([file()]));
    const id = intake.items[0].id;
    act(() => intake.cancel(id));

    // A `FileReader` can deliver one more event after `abort()` in some
    // engines. It must not put the file back.
    act(() => started[0].handlers.onDone('data:image/png;base64,LATE'));

    expect(added).toHaveLength(0);
    expect(intake.items).toHaveLength(0);
  });

  it('cannot be retried once cancelled — the file was let go of', () => {
    act(() => intake.accept([file()]));
    const id = intake.items[0].id;
    act(() => intake.cancel(id));

    act(() => intake.retry(id));

    // Retry re-reads the `File`, and cancel drops it. A retry that quietly
    // started a second read of nothing would be the control-wired-to-nothing
    // this whole change exists to avoid.
    expect(started).toHaveLength(1);
  });
});

describe('retry', () => {
  it('keeps a failed file so it can be read again', () => {
    act(() => intake.accept([file({ name: 'flaky.png' })]));
    act(() => started[0].handlers.onFailed());

    expect(intake.items[0].status).toBe('failed');
    expect(intake.items[0].fraction).toBeNull();

    act(() => intake.retry(intake.items[0].id));

    // A second read, of the same file — not a second queue entry.
    expect(started).toHaveLength(2);
    expect(started[1].file).toBe(started[0].file);
    expect(intake.items).toHaveLength(1);
    expect(intake.items[0].status).toBe('reading');
  });

  it('reaches the end on the second attempt', () => {
    act(() => intake.accept([file()]));
    act(() => started[0].handlers.onFailed());
    act(() => intake.retry(intake.items[0].id));
    act(() => started[1].handlers.onDone('data:image/png;base64,BBBB'));

    expect(added).toHaveLength(1);
    expect(intake.items).toHaveLength(0);
  });
});

describe('what is held, and let go', () => {
  it('stops sending while anything is still being read', () => {
    act(() => intake.accept([file()]));
    expect(intake.isBusy).toBe(true);

    act(() => started[0].handlers.onDone('data:image/png;base64,CCCC'));
    expect(intake.isBusy).toBe(false);
  });

  it('does not count a failed file as work in progress', () => {
    act(() => intake.accept([file()]));
    act(() => started[0].handlers.onFailed());

    // Otherwise a read that failed would lock the send button for good, and
    // the only way out would be to find the discard control.
    expect(intake.isBusy).toBe(false);
  });

  it('aborts every live read when the composer goes away', () => {
    act(() => intake.accept([file({ name: 'a.png' }), file({ name: 'b.png' })]));

    act(() => renderer?.unmount());
    renderer = null;

    // A reader outliving its composer holds its `File`, and a 20 MiB drop is
    // 20 MiB held until the read finishes into a tree that no longer exists.
    expect(started[0].abort).toHaveBeenCalledTimes(1);
    expect(started[1].abort).toHaveBeenCalledTimes(1);
  });
});
