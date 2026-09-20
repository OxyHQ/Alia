import React from "react";
import { View, Pressable, ScrollView, ActivityIndicator } from "react-native";
import { Image } from "expo-image";
import { LinearGradient } from "expo-linear-gradient";
import { withAlpha } from "@oxy.so/bloom/theme";
import {
  FileText,
  FileSpreadsheet,
  FileCode,
  FileArchive,
  FileAudio,
  File,
  X,
  RotateCw,
  TriangleAlert,
} from "lucide-react-native";
import { Text } from "@/components/ui/text";
import { useColorScheme } from "@/lib/useColorScheme";
import { useTranslation } from "@/lib/hooks/use-translation";
import { MAX_ATTACHMENT_BYTES } from "@/lib/chat/attachment-intake";
import {
  usePromptInput,
  ATTACHMENT_TILE_RADIUS,
  type Attachment,
} from "./context";
import type { IntakeItem } from "./use-attachment-intake";

/**
 * How strongly a file-type hue tints its icon well.
 *
 * Through `withAlpha`, never by appending to the colour: these resolve to
 * `rgb(...)` strings, so `` `${colors.error}18` `` is malformed and
 * react-native-web reads it back as fully OPAQUE — which would paint the icon
 * on its own colour, at a contrast of 1.
 */
const TINT = 0.09;

type FileKind = {
  Icon: typeof File;
  /** Which of the theme's hues names this kind. */
  hue: "error" | "info" | "success" | "warning" | "secondary" | "tertiary" | "muted";
  /** What the tile calls it, under the name. */
  label: string;
};

function getFileKind(mimeType: string, name: string): FileKind {
  const ext = name.split(".").pop()?.toLowerCase() || "";

  if (mimeType === "application/pdf" || ext === "pdf")
    return { Icon: FileText, hue: "error", label: "PDF" };
  if (mimeType.includes("word") || ["doc", "docx"].includes(ext))
    return { Icon: FileText, hue: "info", label: "Document" };
  if (
    mimeType.includes("spreadsheet") ||
    mimeType.includes("excel") ||
    ["xls", "xlsx", "csv"].includes(ext)
  )
    return { Icon: FileSpreadsheet, hue: "success", label: "Spreadsheet" };
  if (
    [
      "js",
      "ts",
      "tsx",
      "jsx",
      "py",
      "rb",
      "go",
      "rs",
      "java",
      "c",
      "cpp",
      "h",
      "json",
      "xml",
      "yaml",
      "yml",
      "html",
      "css",
      "scss",
      "sh",
      "sql",
    ].includes(ext)
  )
    return { Icon: FileCode, hue: "tertiary", label: "Code" };
  if (
    mimeType.includes("zip") ||
    mimeType.includes("archive") ||
    ["zip", "rar", "tar", "gz", "7z"].includes(ext)
  )
    return { Icon: FileArchive, hue: "warning", label: "Archive" };
  if (
    mimeType.startsWith("audio/") ||
    ["mp3", "wav", "ogg", "flac", "aac"].includes(ext)
  )
    return { Icon: FileAudio, hue: "secondary", label: "Audio" };
  if (mimeType === "text/plain" || ["txt", "md", "rtf"].includes(ext))
    return { Icon: FileText, hue: "muted", label: "Text" };
  return { Icon: File, hue: "muted", label: "File" };
}

/**
 * The one control that has to say WHICH attachment it drops.
 *
 * Position as well as name, because two files can share a name and "Remove
 * report.pdf" then names both of them.
 */
function RemoveButton({
  onRemove,
  label,
}: {
  onRemove: () => void;
  label: string;
}) {
  return (
    <Pressable
      onPress={onRemove}
      // Half outside the tile, so it reads as attached to it rather than as
      // something sitting on the content.
      className="absolute -top-1.5 -right-1.5 h-4 w-4 items-center justify-center rounded-full border border-border bg-background active:opacity-70"
      accessibilityRole="button"
      accessibilityLabel={label}
    >
      <X size={10} className="text-foreground" />
    </Pressable>
  );
}

function ImageTile({ attachment }: { attachment: Attachment }) {
  return (
    <View
      // Small and square — a picture says what it is, so the tile is just the
      // picture. Only the corner rides on `style`, because it is derived from
      // the composer's and so has no class to name it.
      className="h-14 w-14 overflow-hidden border border-border bg-muted"
      style={{ borderRadius: ATTACHMENT_TILE_RADIUS }}
    >
      {!attachment.isLoading && attachment.uri ? (
        // No caption over the picture. The thumbnail already says which one it
        // is, and a name across it only hides the part that does the saying.
        <Image
          source={{ uri: attachment.uri }}
          className="h-full w-full"
          contentFit="cover"
        />
      ) : (
        <View className="absolute inset-0 items-center justify-center bg-muted">
          {/*
           * Indeterminate, and it stays that way. `isLoading` is a flag a
           * CONSUMER may set on an attachment it owns; it carries no byte
           * count and never did, so there is no percentage here to draw and
           * one drawn anyway would be invented. Files the composer itself is
           * still reading are not attachments at all — they queue in
           * `use-attachment-intake.ts` and render as `IntakeTile` below, which
           * does have a measurement to show.
           */}
          <ActivityIndicator size="small" />
        </View>
      )}
    </View>
  );
}

/**
 * A file that is not an attachment yet — being read, failed, or turned away.
 *
 * It wears the WIDE shape rather than the picture's square even when the file
 * is a picture, and that is the honest choice: there is no thumbnail to show
 * until the read finishes, so the square would be an empty box with a spinner
 * in it and no way to tell which of three dropped files it was. The wide tile
 * has room for the name, for what is happening to it, and — the part a square
 * has nowhere to put — for the sentence explaining a refusal. It becomes the
 * square the moment the bytes land and there is a picture to be.
 *
 * Only pictures are ever READ here. A dropped document goes straight into the
 * attachment list with an object URL, because `buildMessageContent` keeps only
 * `type === 'image'` and a document's bytes therefore go nowhere; a progress
 * bar over a read whose result nobody consumes would be theatre. A picture on
 * web has to become a `data:` URL before it can be sent at all, and that read
 * is the one measurable, interruptible piece of work in the whole path.
 */
function IntakeTile({
  item,
  onCancel,
  onRetry,
}: {
  item: IntakeItem;
  onCancel: () => void;
  onRetry: () => void;
}) {
  const { colors } = useColorScheme();
  const { t } = useTranslation();
  const name = item.name || t("composer.untitled");
  const reading = item.status === "reading";
  const percent = item.fraction === null ? null : Math.round(item.fraction * 100);
  const tone = reading ? colors.mutedForeground : colors.error;

  /** What went wrong, in a sentence, for the two kinds of wrong there are. */
  const trouble =
    item.status === "refused"
      ? item.refusal === "too-large"
        ? t("composer.fileTooLarge", {
            name,
            limit: `${Math.round(MAX_ATTACHMENT_BYTES / (1024 * 1024))} MB`,
          })
        : t("composer.fileEmpty", { name })
      : t("composer.readFailed", { name });

  return (
    <View
      className="w-60 flex-row items-center gap-3 border border-border bg-muted/30 px-3 py-2.5 md:w-80"
      style={{ borderRadius: ATTACHMENT_TILE_RADIUS }}
      // Announced as what it is. A determinate read reports its position, an
      // unmeasurable one reports only that it is happening — the same
      // distinction the pixels make, in the same two cases, so a reader is
      // never told a number the screen does not show.
      accessibilityRole={reading ? "progressbar" : "text"}
      accessibilityLabel={
        !reading
          ? trouble
          : percent === null
            ? t("composer.readingFile", { name })
            : t("composer.readingFileProgress", { name, percent })
      }
      accessibilityValue={
        reading && percent !== null ? { min: 0, max: 100, now: percent } : undefined
      }
    >
      <View
        className="h-10 w-10 shrink-0 items-center justify-center rounded-xl"
        style={{ backgroundColor: withAlpha(tone, TINT) }}
      >
        {reading ? (
          /*
           * Two indicators, never both, and the choice is the measurement.
           * `readFraction` returns `null` when the browser said the read was
           * not length-computable, and this is where that `null` is honoured:
           * a spinner, which claims nothing. It is not a fallback that quietly
           * becomes a bar at 0% — an empty bar reads as a stuck transfer, and
           * a moving one would be the invented percentage #608 §7 forbids.
           */
          percent === null ? (
            <ActivityIndicator size="small" />
          ) : (
            <Text className="text-[11px] font-semibold text-muted-foreground">
              {`${percent}%`}
            </Text>
          )
        ) : (
          <TriangleAlert size={20} color={tone} />
        )}
      </View>

      {/* `min-w-0`, for the same reason `FileTile` needs it: without it a flex
          child refuses to shrink past its content, so the name never reaches
          an ellipsis and the tile is pushed wider instead. */}
      <View className="min-w-0 flex-1">
        <Text className="text-sm font-semibold text-foreground" numberOfLines={1}>
          {name}
        </Text>
        {reading ? (
          <View className="mt-1.5 h-1 overflow-hidden rounded-full bg-border">
            <View
              className="h-full bg-primary"
              // A runtime percentage has no class to name it. An unmeasured
              // read draws no fill at all rather than a sliver that would read
              // as "a little way in".
              style={{ width: percent === null ? "0%" : `${percent}%` }}
            />
          </View>
        ) : (
          <Text className="text-xs text-muted-foreground" numberOfLines={2}>
            {trouble}
          </Text>
        )}
      </View>

      {/*
       * Retry stands beside the name rather than replacing the tile, because
       * the tile is what says WHICH file failed — and it exists only where
       * there is something left to retry. A refused file has no second
       * outcome: the same 30 MB read again is the same 30 MB, and a button
       * that re-runs a decision already made is a control wired to nothing.
       */}
      {item.status === "failed" && (
        <Pressable
          onPress={onRetry}
          accessibilityRole="button"
          accessibilityLabel={t("composer.retryRead", { name })}
          className="h-8 w-8 shrink-0 items-center justify-center rounded-full border border-border bg-background active:opacity-70"
        >
          <RotateCw size={14} color={colors.foreground} />
        </Pressable>
      )}

      <Pressable
        onPress={onCancel}
        className="absolute -top-1.5 -right-1.5 h-4 w-4 items-center justify-center rounded-full border border-border bg-background active:opacity-70"
        accessibilityRole="button"
        // The same corner control, two truthful names. While the read runs it
        // stops it — `FileReader.abort()`, a real interruption of real work
        // and not a button that hides a row. Once the read has ended there is
        // nothing left to stop, so it discards instead.
        accessibilityLabel={
          reading
            ? t("composer.cancelRead", { name })
            : t("composer.dismissFailed", { name })
        }
      >
        <X size={10} className="text-foreground" />
      </Pressable>
    </View>
  );
}

function FileTile({ attachment }: { attachment: Attachment }) {
  const { colors } = useColorScheme();
  const { Icon, hue, label } = getFileKind(attachment.mimeType, attachment.name);
  const tone = hue === "muted" ? colors.mutedForeground : colors[hue];

  return (
    <View
      // Wide, because unlike a picture a file has to be read to be told apart.
      className="w-60 flex-row items-center gap-3 border border-border bg-muted/30 px-3 py-2.5 md:w-80"
      style={{ borderRadius: ATTACHMENT_TILE_RADIUS }}
    >
      <View
        className="h-10 w-10 shrink-0 items-center justify-center rounded-xl"
        style={{ backgroundColor: withAlpha(tone, TINT) }}
      >
        <Icon size={20} color={tone} />
      </View>
      {/*
       * `min-w-0` is what lets a long name truncate instead of widening the
       * tile: a flex child will not shrink past its content without it, so the
       * ellipsis never arrives and the row is pushed instead.
       */}
      <View className="min-w-0 flex-1">
        <Text
          className="text-sm font-semibold text-foreground"
          numberOfLines={1}
        >
          {attachment.name}
        </Text>
        <Text className="text-xs text-muted-foreground" numberOfLines={1}>
          {label}
        </Text>
      </View>
    </View>
  );
}

/**
 * The strip of what is going out with the next message.
 *
 * ## Why this is not Bloom's `ComposerAttachments`
 *
 * The family has a tile strip with an upload ring around each tile, and it is
 * driven by `composer-panel/use-attachment-queue.ts`, whose own doc comment
 * says outright that "the upload is SIMULATED". It advances the ring on a 50ms
 * tick by `step * (0.55 + Math.random() * 0.9)`, and fires `onUploadComplete`
 * when the animation ends — whether or not a byte moved. There is no error
 * state, no retry and no cancel in the type.
 *
 * Alia's strip now shows a percentage in one place and refuses to in every
 * other, and the line between them is what the app can actually measure.
 * There is no upload anywhere in Alia — an attachment waits in the store until
 * the message is sent and is then inlined into the request — so nothing is
 * ever in flight to a server to ring a tile against. What IS measurable is the
 * local read a web `File` needs before it can be inlined at all: `FileReader`
 * reports `loaded` and `total`, and `abort()` stops it. That read, and only
 * that read, gets a bar; everything else gets an indeterminate spinner or
 * nothing. See `IntakeTile`.
 *
 * The adoptable half of Bloom's family is `ComposerPanelAttachment.progress`,
 * a genuinely controlled 0–100, but it is only consumed by `ComposerPanel`,
 * which has no `onStop` and brings its own text field — and the type has no
 * failure state at all, so the failed-and-retryable tile below could not be
 * expressed in it even then.
 */
export function PromptInputAttachments() {
  const { attachments, removeAttachment, intake } = usePromptInput();
  const { colors } = useColorScheme();
  const { t } = useTranslation();

  // `?.` and not a default: the context field is optional because the tests in
  // this directory build their provider value by casting a partial object, and
  // a required field would be `undefined` in a tree TypeScript called safe.
  const pending = intake?.items ?? [];

  if (attachments.length === 0 && pending.length === 0) return null;

  // Fades to a fully transparent version of the surface it sits on. Fading to
  // `transparent` instead would pass through black on the way out on some
  // platforms, which shows up as a dark smear at each end.
  const fadeFrom = colors.surface;
  const fadeTo = withAlpha(colors.surface, 0);

  return (
    <View className="relative mb-2 pt-4">
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        className="flex-none"
        contentContainerClassName="gap-2.5 px-5"
      >
        {attachments.map((attachment, index) => (
          <View key={attachment.id} className="relative">
            {attachment.type === "image" ? (
              <ImageTile attachment={attachment} />
            ) : (
              <FileTile attachment={attachment} />
            )}
            <RemoveButton
              onRemove={() => removeAttachment(attachment.id)}
              label={t("composer.remove", {
                position: index + 1,
                name: attachment.name || t("composer.untitled"),
              })}
            />
          </View>
        ))}
        {/*
         * After the settled tiles, not before them. A file being read arrived
         * most recently, and it becomes an attachment in place: the row it
         * occupies here is the row its tile takes once the bytes land, so
         * nothing shifts sideways under the pointer at the moment the read
         * finishes.
         */}
        {pending.map((item) => (
          <IntakeTile
            key={item.id}
            item={item}
            onCancel={() => intake?.cancel(item.id)}
            onRetry={() => intake?.retry(item.id)}
          />
        ))}
      </ScrollView>

      {/*
       * The ends fade so a row that runs past the edge says so. They are
       * siblings of the ScrollView rather than children because a child scrolls
       * away with the content it is meant to be fading.
       */}
      <LinearGradient
        pointerEvents="none"
        colors={[fadeFrom, fadeTo]}
        start={{ x: 0, y: 0 }}
        end={{ x: 1, y: 0 }}
        className="absolute bottom-0 left-0 top-0 w-6"
      />
      <LinearGradient
        pointerEvents="none"
        colors={[fadeTo, fadeFrom]}
        start={{ x: 0, y: 0 }}
        end={{ x: 1, y: 0 }}
        className="absolute bottom-0 right-0 top-0 w-6"
      />
    </View>
  );
}
