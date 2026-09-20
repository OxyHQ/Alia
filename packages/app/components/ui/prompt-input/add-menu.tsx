import React from "react";
import { Camera } from "lucide-react-native";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import * as DropdownMenu from "@/components/ui/dropdown-menu";
import { useImagePicker, type ImagePickerAsset } from "@/lib/hooks/use-image-picker";
import { useDocumentPicker } from "@/lib/hooks/use-document-picker";
import { useColorScheme } from "@/lib/useColorScheme";
import { useTranslation } from "@/lib/hooks/use-translation";
import { usePromptInput } from "./context";
import { ComposerGlyph } from "./composer-glyph";

/**
 * The plus button, and what can be added to a turn.
 *
 * Bloom describes the same menu as data — `ComposerPanelAddMenuGroup`, a label
 * and rows of `{ id, label, description?, icon? }`, with `onAddMenuSelect`
 * returning the row's id — and the shape is right. It is not reachable from
 * here: the groups are a prop of `ComposerPanel` and `ComposerPill`, rendered
 * by an `AddMenu` neither family exports, so taking the data model would mean
 * taking the composer it hangs off. Alia's rows also do more than name
 * themselves — each one owns a picker and writes the result into the
 * attachment list — and `children` carries the capability menu the page builds
 * from skills and connectors, which has no counterpart in that type at all.
 */
export type PromptInputAddMenuProps = {
  className?: string;
  iconSize?: number;
  children?: React.ReactNode;
};

export function PromptInputAddMenu({
  className,
  iconSize = 18,
  children,
}: PromptInputAddMenuProps) {
  const { addAttachment, disabled, isLoading } = usePromptInput();
  const { pickImage, takePhoto } = useImagePicker();
  const { pickDocument } = useDocumentPicker();
  const { colors } = useColorScheme();
  const { t } = useTranslation();

  const addImages = (assets: ImagePickerAsset[] | undefined) => {
    assets?.forEach((asset) => {
      addAttachment({
        id: `img-${Date.now()}-${Math.random().toString(36).slice(2)}`,
        uri: asset.uri,
        type: "image",
        name: asset.name,
        size: asset.size,
        mimeType: asset.mimeType,
      });
    });
  };

  const handleCamera = async () => addImages(await takePhoto());

  const handleAddPhotos = async () => addImages(await pickImage());

  const handleAddDocument = async () => {
    const docs = await pickDocument();
    docs?.forEach((doc) => {
      addAttachment({
        id: `doc-${Date.now()}-${Math.random().toString(36).slice(2)}`,
        uri: doc.uri,
        type: "document",
        name: doc.name,
        size: doc.size,
        mimeType: doc.mimeType,
      });
    });
  };

  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger>
        <Button
          variant="ghost"
          size="icon"
          className={cn(
            "h-10 w-10 rounded-full items-center justify-center web:hover:bg-muted active:bg-muted",
            className
          )}
          accessibilityLabel={t("composer.addMenu")}
          // Nothing can be attached to a turn that is streaming, or to a
          // composer the usage limit has closed. Locked on the control itself
          // so the lock is reported for THIS button and not inherited by the
          // stop button from a disabled ancestor.
          disabled={disabled || isLoading}
        >
          <ComposerGlyph name="plus" size={iconSize} color={colors.mutedForeground} />
        </Button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Content side="top" align="start" className="w-72 rounded-2xl py-1.5 shadow-xl">
        <DropdownMenu.Item key="camera" onSelect={handleCamera}>
          <DropdownMenu.ItemIcon ios={{ name: "camera" }}>
            <Camera size={20} color={colors.foreground} />
          </DropdownMenu.ItemIcon>
          <DropdownMenu.ItemTitle>{t("composer.camera")}</DropdownMenu.ItemTitle>
        </DropdownMenu.Item>
        <DropdownMenu.Item key="photos" onSelect={handleAddPhotos}>
          <DropdownMenu.ItemIcon ios={{ name: "photo" }}>
            <ComposerGlyph name="image" color={colors.foreground} />
          </DropdownMenu.ItemIcon>
          <DropdownMenu.ItemTitle>{t("composer.photos")}</DropdownMenu.ItemTitle>
        </DropdownMenu.Item>
        <DropdownMenu.Item key="document" onSelect={handleAddDocument}>
          <DropdownMenu.ItemIcon ios={{ name: "folder" }}>
            <ComposerGlyph name="file" color={colors.foreground} />
          </DropdownMenu.ItemIcon>
          <DropdownMenu.ItemTitle>{t("composer.files")}</DropdownMenu.ItemTitle>
        </DropdownMenu.Item>
        {children != null && (
          <>
            <DropdownMenu.Separator />
            {children}
          </>
        )}
      </DropdownMenu.Content>
    </DropdownMenu.Root>
  );
}
