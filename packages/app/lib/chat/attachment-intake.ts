/**
 * What the composer will take in, and how far a file has actually got.
 *
 * Alia had no answer to either question. A file reached the attachment strip
 * by exactly one route — a picker that hands back a `uri` and asks nothing —
 * so there was no size it would refuse, no kind it would separate, and, once
 * drag-and-drop existed, no shared place to state those rules for a second
 * route. Worse, a drag is a stateful gesture: the browser fires `dragenter`
 * and `dragleave` for every element the pointer crosses, so a drop affordance
 * driven by a boolean flickers off the instant the pointer moves from the bar
 * onto the textarea INSIDE it. The counter that fixes that is four lines of
 * arithmetic guarding a visible effect, which is precisely the kind of thing
 * that is easy to get subtly wrong and almost impossible to watch going wrong.
 *
 * So it lives here, beside `composer-state.ts`, under the same rule: nothing
 * in this file may import react-native, read a store, or touch the DOM. The
 * reader that moves the bytes is a platform adapter and lives with the
 * composer; what can be decided by arithmetic is decided here, where it can be
 * checked without mounting a composer or staging a drag.
 */

/**
 * The largest file the composer will take.
 *
 * An attached image is not uploaded anywhere — `lib/attachment-utils.ts`
 * inlines it into the request as a `data:` URL — so its bytes are carried in
 * memory as a base64 string roughly a third larger than the file, twice over
 * while the request is built. 20 MiB is the point past which that stops being
 * a message and starts being a reason the tab dies.
 */
export const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;

export type IntakeKind = "image" | "document";

/** Why a file was turned away. Each one has its own sentence to the user. */
export type IntakeRefusal = "empty" | "too-large";

export type IntakeVerdict =
  | { accepted: true; kind: IntakeKind }
  | { accepted: false; refusal: IntakeRefusal };

export interface IntakeCandidate {
  name: string;
  mimeType: string;
  size: number;
}

/**
 * Extensions that name a picture when the browser will not.
 *
 * A dragged file's `type` is filled in from the OS, and it comes through empty
 * often enough to matter — from an archive manager, from a file manager with a
 * thin mime database, from anything that drops a path rather than a handle.
 * Falling back to the name is not a nicety: without it a dropped `.png` is
 * filed as a document, and a document is never inlined into the request at all.
 */
const IMAGE_EXTENSIONS = [
  "png",
  "jpg",
  "jpeg",
  "gif",
  "webp",
  "bmp",
  "avif",
  "heic",
  "heif",
];

/**
 * Whether a candidate is a picture, by what the browser says first and by its
 * name only when the browser said nothing.
 */
export function intakeKind(candidate: IntakeCandidate): IntakeKind {
  if (candidate.mimeType.startsWith("image/")) return "image";
  const extension = candidate.name.split(".").pop()?.toLowerCase() ?? "";
  return IMAGE_EXTENSIONS.includes(extension) ? "image" : "document";
}

/**
 * The one gate both web routes pass through — pasted files and dropped ones —
 * so a rule cannot hold for one and not the other.
 *
 * The zero-byte refusal is not pedantry about empty files. Dropping a FOLDER
 * on web yields a `File` with size 0 and no type, in every browser; without
 * this the composer accepts a tile named after a directory whose contents it
 * will never have, and whose read completes with nothing in it.
 */
export function classifyIntake(candidate: IntakeCandidate): IntakeVerdict {
  if (candidate.size <= 0) return { accepted: false, refusal: "empty" };
  if (candidate.size > MAX_ATTACHMENT_BYTES)
    return { accepted: false, refusal: "too-large" };
  return { accepted: true, kind: intakeKind(candidate) };
}

/** The four things that can happen to the count of drags over the composer. */
export type DragStep = "enter" | "leave" | "drop" | "reset";

/**
 * How many dragged-over elements deep the pointer is.
 *
 * `dragenter` and `dragleave` fire per ELEMENT, not per target, and they fire
 * in that order: moving from the bar onto the textarea inside it produces
 * `dragenter` (textarea) then `dragleave` (bar). A boolean set by enter and
 * cleared by leave therefore ends that move switched OFF while the pointer is
 * still over the composer, and the affordance strobes as the pointer crosses
 * each child on the way in. Counting elements instead is the standard answer,
 * and the depth only reaches zero when the pointer has genuinely left
 * everything.
 *
 * `drop` resets rather than decrements: the browser does not send the matching
 * `dragleave` for the element the file landed on, so a decrement leaves the
 * count stuck at one and the overlay pinned over the composer for good.
 */
export function nextDragDepth(depth: number, step: DragStep): number {
  switch (step) {
    case "enter":
      return depth + 1;
    case "leave":
      // Clamped, because a `dragleave` can arrive without its `dragenter` — a
      // drag that began before the listener was attached, or one whose
      // `dragenter` was swallowed by an element that stopped propagation. A
      // negative depth would then need two full entries before the overlay
      // came back.
      return Math.max(0, depth - 1);
    case "drop":
    case "reset":
      return 0;
  }
}

/**
 * Whether this drag is carrying files at all.
 *
 * `DataTransfer.types` contains the literal `"Files"` when it is; dragging
 * selected text or a link gives `"text/plain"` and `"text/uri-list"` instead.
 * Without the question the composer lights up when the user drags a word
 * across it, and then swallows the drop.
 */
export function dragCarriesFiles(types: readonly string[] | undefined): boolean {
  return types !== undefined && types.includes("Files");
}

/**
 * How far a read has got, as a fraction — or `null` when nothing measurable
 * was reported.
 *
 * `null` is the important return, and it is why this is a function rather than
 * a division at the call site. #608 §7: "Cuando no hay avance medible, mostrar
 * actividad indeterminada. No inventar porcentajes." A `ProgressEvent` whose
 * `lengthComputable` is false carries a `total` of 0, and dividing by it gives
 * `NaN` or `Infinity` — both of which render as SOMETHING once handed to a
 * bar, and that something is invented. Bloom's `use-attachment-queue.ts`
 * invents its number outright, from a `Math.random()` ramp on a 50ms tick;
 * nothing in this file may grow a timer.
 */
export function readFraction(progress: {
  lengthComputable: boolean;
  loaded: number;
  total: number;
}): number | null {
  if (!progress.lengthComputable) return null;
  if (!Number.isFinite(progress.total) || progress.total <= 0) return null;
  if (!Number.isFinite(progress.loaded) || progress.loaded < 0) return null;
  return Math.min(1, progress.loaded / progress.total);
}
