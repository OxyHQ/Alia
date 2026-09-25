import React from "react";
import {
  classifyIntake,
  readFraction,
  type IntakeKind,
  type IntakeRefusal,
} from "@/lib/chat/attachment-intake";
import type { Attachment } from "./types";

/**
 * The composer's own file intake: the queue between "the user handed us a
 * file" and "the attachment strip has it".
 *
 * ## There is no upload
 *
 * This is the first thing to know, and it decides everything below. Nothing in
 * Alia uploads an attachment. A picked file becomes a `uri` and sits in the
 * store until the message is sent, at which point `lib/attachment-utils.ts`
 * inlines the images into the request body as `data:` URLs and drops the
 * documents on the floor. There is no endpoint, no `FormData`, no XHR — so
 * there are no bytes in flight to measure and nothing an abort could stop.
 *
 * What there IS, on web, is a read. A `File` that arrives by paste or by drop
 * is a handle, not bytes, and it has to be read into a `data:` URL before it
 * can be sent — a real transfer of real bytes, of a size the user chose, that
 * takes real time for anything above a few megabytes. `FileReader` reports
 * that read through `progress` events carrying `lengthComputable`, `loaded`
 * and `total`, and it can be stopped with `abort()`. So the progress this
 * queue shows is measured and the cancel button ends something: they are the
 * read, honestly labelled, and not a stand-in for an upload that does not
 * exist. When the browser declines to make the read measurable the tile says
 * so by showing indeterminate activity — see `readFraction`.
 *
 * ## Why the queue is separate from the attachment list
 *
 * A file that is still being read is not an attachment yet: it has no `uri`,
 * so `buildMessageContent` would silently skip it, and the strip would show a
 * tile that contributes nothing to the message. It also cannot be REPAIRED in
 * place — `PromptInput` only forwards an `onUpdateAttachment` when its consumer
 * supplies one, and the chat page supplies `attachments`, `onAddAttachment`
 * and `onRemoveAttachment` and no updater at all, so every `updateAttachment`
 * from inside the composer lands in internal state that the controlled list
 * shadows and nothing ever renders. (That is why the old paste path reached
 * around the composer and called `useStore.getState().updateAttachment`
 * directly.) Holding the in-flight files here instead means the strip's
 * pending rows work the same whether the consumer wired an updater or not, and
 * an attachment is only ever handed over once it has bytes behind it.
 */

/** A file the composer is working on, has failed to read, or will not take. */
export interface IntakeItem {
  id: string;
  name: string;
  size: number;
  mimeType: string;
  kind: IntakeKind;
  /**
   * `reading` while the bytes move, `failed` once they did not, `refused` for
   * a file that never started — too big, or a dropped folder.
   *
   * A refusal is a queue entry rather than a toast for two reasons. It stays
   * put: a drop of six files where one was too large is a sentence the user
   * needs beside the five that worked, not one that slides away after four
   * seconds. And it keeps the composer free of a notification dependency —
   * `@oxy.so/bloom/toast` is a module the composer's own test suites do not
   * stub, and a component that cannot be mounted in a test is a component
   * whose behaviour nothing pins.
   */
  status: "reading" | "failed" | "refused";
  /**
   * How far the read has got, 0–1 — or `null` for "no measurable progress",
   * which the tile must render as indeterminate activity rather than as a
   * number. Never a timer, never a guess.
   */
  fraction: number | null;
  /** Set only on a `refused` row: which sentence to show. */
  refusal?: IntakeRefusal;
}

/** A started read, and the one thing a caller can do to it. */
export interface ReadHandle {
  abort: () => void;
}

export interface ReadHandlers {
  onProgress: (fraction: number | null) => void;
  onDone: (dataUrl: string) => void;
  onFailed: () => void;
}

/**
 * Begins a read and hands back the way to stop it. Injectable because
 * `FileReader` is a browser API and the tests run in node — and because a test
 * that cannot drive a read step by step cannot pin what cancel and retry do.
 */
export type StartRead = (file: Blob, handlers: ReadHandlers) => ReadHandle;

/**
 * The real reader: `FileReader`, the app's ONLY genuine cancellation point in
 * the whole attachment path.
 */
const startFileRead: StartRead = (file, handlers) => {
  const reader = new FileReader();
  reader.onprogress = (event) => handlers.onProgress(readFraction(event));
  reader.onload = () => {
    const result = reader.result;
    // A `readAsDataURL` result is always a string when it succeeded; anything
    // else means the read did not produce what the message needs, and a
    // failure the user can retry is the truthful reading of that.
    if (typeof result === "string") handlers.onDone(result);
    else handlers.onFailed();
  };
  reader.onerror = () => handlers.onFailed();
  reader.readAsDataURL(file);
  return { abort: () => reader.abort() };
};

export interface AttachmentIntake {
  /** In-flight and failed files, in the order they arrived. */
  items: IntakeItem[];
  /** Take a batch of files from a paste or a drop. */
  accept: (files: readonly File[]) => void;
  /** Stop a read and drop the file. */
  cancel: (id: string) => void;
  /** Read a failed file again, from the file itself. */
  retry: (id: string) => void;
  /** Give up on a failed or refused file. */
  dismiss: (id: string) => void;
  /** True while anything is still being read — nothing may be sent yet. */
  isBusy: boolean;
}

export interface AttachmentIntakeOptions {
  addAttachment: (attachment: Attachment) => void;
  /** Swapped out by the tests; the real one is `startFileRead`. */
  startRead?: StartRead;
}

/** Ids that cannot collide, without a `Math.random()` anywhere near progress. */
let sequence = 0;
const nextId = (prefix: string) => `${prefix}-${Date.now()}-${++sequence}`;

export function useAttachmentIntake({
  addAttachment,
  startRead = startFileRead,
}: AttachmentIntakeOptions): AttachmentIntake {
  const [items, setItems] = React.useState<IntakeItem[]>([]);

  /**
   * The live reads and the files behind them, by item id.
   *
   * Refs rather than state, and deliberately so: a read handle is not
   * something the strip draws, and re-rendering the composer every time a
   * reader is registered would be a render per file per keystroke-free tick.
   * More importantly `cancel` must reach the reader that is running NOW — a
   * handle captured in a closure over state would be one render stale, which
   * for a cancel button means aborting the read before last.
   *
   * The file is kept alongside for exactly one reason: retry has to re-read
   * something, and the `File` is the only thing that still holds the bytes.
   * Both maps are cleared the moment an item leaves the queue, which is what
   * makes "release the reading resources" true rather than aspirational.
   */
  const reads = React.useRef(new Map<string, ReadHandle>());
  const sources = React.useRef(new Map<string, File>());

  const forget = React.useCallback((id: string) => {
    reads.current.get(id)?.abort();
    reads.current.delete(id);
    sources.current.delete(id);
  }, []);

  const begin = React.useCallback(
    (id: string, file: File, kind: IntakeKind) => {
      /**
       * Whether this read is still the one we are waiting on.
       *
       * `abort()` is a request, not a guarantee: a `FileReader` may still
       * deliver a queued event afterwards, and some engines fire `load` for a
       * read that had already completed in the background when the abort
       * arrived. Without this check a cancelled file lands in the attachment
       * list a beat after the user removed it — the row comes BACK — which is
       * the failure mode that makes a cancel button worse than none.
       *
       * The map is the record of what is live, so asking it is also what makes
       * "cancel" and "unmount" mean the same thing here.
       */
      const live = () => reads.current.has(id);

      /*
       * Registered BEFORE the read starts, then swapped for the real handle.
       * A cached file can be read synchronously — the browser has the bytes
       * already — and `onDone` would then run inside `startRead`, before there
       * was anything in the map to say this read was live. The placeholder is
       * what stops that completion being mistaken for a stale one and dropped.
       */
      const placeholder: ReadHandle = { abort: () => {} };
      reads.current.set(id, placeholder);

      const handle = startRead(file, {
        onProgress: (fraction) => {
          if (!live()) return;
          setItems((prev) =>
            prev.map((item) =>
              item.id === id && item.status === "reading"
                ? { ...item, fraction }
                : item,
            ),
          );
        },
        onDone: (dataUrl) => {
          if (!live()) return;
          // The read is over before the attachment exists, so the handle and
          // the file go first: a completed reader kept in the map is a `File`
          // kept alive, which for a 20 MiB drop is 20 MiB held for the life of
          // the composer.
          reads.current.delete(id);
          sources.current.delete(id);
          setItems((prev) => prev.filter((item) => item.id !== id));
          addAttachment({
            id,
            uri: dataUrl,
            type: kind,
            name: file.name,
            size: file.size,
            mimeType: file.type || "application/octet-stream",
          });
        },
        onFailed: () => {
          if (!live()) return;
          // The reader is spent; the FILE is not, and retry needs it. This is
          // the one path that keeps a source around after its read ended.
          reads.current.delete(id);
          setItems((prev) =>
            prev.map((item) =>
              item.id === id ? { ...item, status: "failed", fraction: null } : item,
            ),
          );
        },
      });
      // Only if the placeholder is still there. If the read already finished
      // or failed inside the call above, the map has been moved on and writing
      // the handle back would leave a spent reader registered as live.
      if (reads.current.get(id) === placeholder) reads.current.set(id, handle);
    },
    [addAttachment, startRead],
  );

  const accept = React.useCallback(
    (files: readonly File[]) => {
      const queued: IntakeItem[] = [];
      const starts: Array<() => void> = [];

      for (const file of files) {
        const name = file.name || "";
        const verdict = classifyIntake({
          name,
          mimeType: file.type || "",
          size: file.size,
        });
        const id = nextId("intake");
        if (!verdict.accepted) {
          // A file that silently fails to attach is the worst of the three
          // outcomes: the user sends the message believing the picture went
          // with it. The row names the file, because a drop is usually a batch
          // and "one of them didn't work" is no answer when four were dropped.
          queued.push({
            id,
            name: name || "file",
            size: file.size,
            mimeType: file.type || "",
            kind: "document",
            status: "refused",
            fraction: null,
            refusal: verdict.refusal,
          });
          continue;
        }
        if (verdict.kind === "document") {
          /*
           * A document never gets read. `buildMessageContent` filters the
           * attachment list down to `type === 'image'`, so a document's bytes
           * go nowhere and reading them would be a progress bar over work that
           * exists only to produce a string nobody consumes. The object URL is
           * what the web pickers produce for the same file, it is instant, and
           * the draft store gives it back when the tile is removed.
           */
          addAttachment({
            id,
            uri:
              typeof URL !== "undefined" && typeof URL.createObjectURL === "function"
                ? URL.createObjectURL(file)
                : "",
            type: "document",
            name: name || "file",
            size: file.size,
            mimeType: file.type || "application/octet-stream",
          });
          continue;
        }

        sources.current.set(id, file);
        queued.push({
          id,
          name: name || "image",
          size: file.size,
          mimeType: file.type || "image/*",
          kind: verdict.kind,
          status: "reading",
          // Not zero. Zero is a claim that nothing has moved yet; `null` is the
          // truth, which is that nothing has been reported yet.
          fraction: null,
        });
        starts.push(() => begin(id, file, verdict.kind));
      }

      if (queued.length > 0) setItems((prev) => [...prev, ...queued]);
      // Started after the rows exist, because a synchronous reader — the fake
      // one in the tests, and a cached file in some browsers — can complete
      // inside `startRead`, and a completion for a row that has not been added
      // yet would be filtered against a list it is not in and then re-added by
      // the batch above as a ghost that never finishes.
      for (const start of starts) start();
    },
    [addAttachment, begin],
  );

  const cancel = React.useCallback(
    (id: string) => {
      forget(id);
      setItems((prev) => prev.filter((item) => item.id !== id));
    },
    [forget],
  );

  const dismiss = cancel;

  const retry = React.useCallback(
    (id: string) => {
      // The file IS the guard. A refused row never had one — nothing was
      // read, and reading the same 30 MB again would reach the same verdict —
      // and a cancelled one let go of it, so neither can start a second read
      // by pressing a button the tile does not draw for them anyway.
      const file = sources.current.get(id);
      if (file === undefined) return;
      setItems((prev) =>
        prev.map((item) =>
          item.id === id ? { ...item, status: "reading", fraction: null } : item,
        ),
      );
      // `"image"` is not an assumption: a document is handed over on arrival
      // and never queues, so the only thing that can hold a source is a
      // picture being read.
      begin(id, file, "image");
    },
    [begin],
  );

  /**
   * Nothing survives the composer going away.
   *
   * An in-flight `FileReader` holds its `File`, and a `File` holds the bytes;
   * a composer unmounted mid-read (navigating away, the drawer closing) would
   * otherwise leave both running until the read finished into a `setItems` on
   * a dead tree. Aborting is the whole of the fix and there is nowhere else to
   * put it.
   */
  React.useEffect(() => {
    const live = reads.current;
    const held = sources.current;
    return () => {
      for (const handle of live.values()) handle.abort();
      live.clear();
      held.clear();
    };
  }, []);

  return React.useMemo(
    () => ({
      items,
      accept,
      cancel,
      retry,
      dismiss,
      isBusy: items.some((item) => item.status === "reading"),
    }),
    [items, accept, cancel, retry, dismiss],
  );
}
