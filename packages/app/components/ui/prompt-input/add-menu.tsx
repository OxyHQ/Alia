import React from "react";
import { Camera } from "lucide-react-native";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import * as DropdownMenu from "@/components/ui/dropdown-menu";
import { useImagePicker, type ImagePickerAsset } from "@/lib/hooks/use-image-picker";
import { useDocumentPicker } from "@/lib/hooks/use-document-picker";
import { useColorScheme } from "@/lib/useColorScheme";
import { usePromptInput } from "./context";
import { ComposerGlyph } from "./composer-glyph";

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
  const { addAttachment } = usePromptInput();
  const { pickImage, takePhoto } = useImagePicker();
  const { pickDocument } = useDocumentPicker();
  const { colors } = useColorScheme();

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
          accessibilityLabel="Upload files and more"
        >
          <ComposerGlyph name="plus" size={iconSize} color={colors.mutedForeground} />
        </Button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Content side="top" align="start" className="w-72 rounded-2xl py-1.5 shadow-xl">
        <DropdownMenu.Item key="camera" onSelect={handleCamera}>
          <DropdownMenu.ItemIcon ios={{ name: "camera" }}>
            <Camera size={20} color={colors.foreground} />
          </DropdownMenu.ItemIcon>
          <DropdownMenu.ItemTitle>Camera</DropdownMenu.ItemTitle>
        </DropdownMenu.Item>
        <DropdownMenu.Item key="photos" onSelect={handleAddPhotos}>
          <DropdownMenu.ItemIcon ios={{ name: "photo" }}>
            <ComposerGlyph name="image" color={colors.foreground} />
          </DropdownMenu.ItemIcon>
          <DropdownMenu.ItemTitle>Photos</DropdownMenu.ItemTitle>
        </DropdownMenu.Item>
        <DropdownMenu.Item key="document" onSelect={handleAddDocument}>
          <DropdownMenu.ItemIcon ios={{ name: "folder" }}>
            <ComposerGlyph name="file" color={colors.foreground} />
          </DropdownMenu.ItemIcon>
          <DropdownMenu.ItemTitle>Files</DropdownMenu.ItemTitle>
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
