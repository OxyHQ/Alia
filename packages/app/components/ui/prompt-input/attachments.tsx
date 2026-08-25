import React from "react";
import { View, Pressable, ScrollView, ActivityIndicator } from "react-native";
import { Image } from "expo-image";
import { LinearGradient } from "expo-linear-gradient";
import { withAlpha } from "@oxyhq/bloom/theme";
import {
  FileText,
  FileSpreadsheet,
  FileCode,
  FileArchive,
  FileAudio,
  File,
  X,
} from "lucide-react-native";
import { Text } from "@/components/ui/text";
import { useColorScheme } from "@/lib/useColorScheme";
import {
  usePromptInput,
  ATTACHMENT_TILE_RADIUS,
  type Attachment,
} from "./context";

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
           * Indeterminate on purpose. There is no upload here to measure: the
           * only thing that ever sets `isLoading` is a pasted image, and it is
           * cleared by `FileReader.onload` reading it into a data URL locally.
           * A ring drawn against a percentage nothing produces would be an
           * invented number.
           */}
          <ActivityIndicator size="small" />
        </View>
      )}
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

export function PromptInputAttachments() {
  const { attachments, removeAttachment } = usePromptInput();
  const { colors } = useColorScheme();

  if (attachments.length === 0) return null;

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
              label={`Remove attachment ${index + 1}: ${attachment.name || "untitled"}`}
            />
          </View>
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
