import type { ComposerPanelAttachment } from "@oxy.so/bloom/composer-panel";
import { MAX_ATTACHMENT_BYTES } from "@/lib/chat/attachment-intake";
import type { IntakeItem } from "./use-attachment-intake";
import type { Attachment } from "./types";

/**
 * The composer's tiles: landed files, then the ones the intake still holds.
 *
 * A file whose read failed, or that was refused, stays in the strip with the
 * sentence that says why — a drop of six where one did not make it is a
 * sentence the user needs beside the five that did, not a toast that slides
 * away. `retryable` marks the ones a second read could fix: a failed read,
 * whose `File` the intake kept. A refusal is not: the same 30 MB file reaches
 * the same verdict.
 */
export interface ComposerTile extends ComposerPanelAttachment {
  error?: string;
  retryable?: boolean;
}

type Translate = (key: string, options?: Record<string, unknown>) => string;

/** Why an intake item is not an attachment, or `undefined` while it is being read. */
export function intakeError(item: IntakeItem, t: Translate): string | undefined {
  const name = item.name || t("composer.untitled");
  switch (item.status) {
    case "reading":
      return undefined;
    case "failed":
      return t("composer.readFailed", { name });
    case "refused":
      return item.refusal === "too-large"
        ? t("composer.fileTooLarge", {
            name,
            limit: `${Math.round(MAX_ATTACHMENT_BYTES / (1024 * 1024))} MB`,
          })
        : t("composer.fileEmpty", { name });
  }
}

export function composerTiles(
  attachments: readonly Attachment[],
  items: readonly IntakeItem[],
  t: Translate,
): ComposerTile[] {
  return [
    ...attachments.map((a) => ({
      id: a.id,
      name: a.name,
      kind: a.type === "image" ? ("image" as const) : ("document" as const),
      src: a.type === "image" ? a.uri : undefined,
    })),
    ...items.map((item): ComposerTile => {
      const tile: ComposerTile = {
        id: item.id,
        name: item.name || t("composer.untitled"),
        kind: item.kind === "image" ? "image" : "document",
      };
      if (item.status === "reading") {
        // Real progress only; an unmeasured read is an empty ring, not a guess.
        tile.progress = item.fraction === null ? 0 : Math.round(item.fraction * 100);
        return tile;
      }
      tile.error = intakeError(item, t);
      tile.retryable = item.status === "failed";
      return tile;
    }),
  ];
}
