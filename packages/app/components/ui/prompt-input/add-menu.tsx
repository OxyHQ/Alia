import React from "react";
import { Plus } from "lucide-react-native";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import * as DropdownMenu from "@/components/ui/dropdown-menu";
import { useImagePicker } from "@/lib/hooks/use-image-picker";
import { useDocumentPicker } from "@/lib/hooks/use-document-picker";
import { usePromptInput } from "./context";

export type PromptInputAddMenuProps = {
  className?: string;
  iconSize?: number;
};

export function PromptInputAddMenu({ className, iconSize = 18 }: PromptInputAddMenuProps) {
  const { addAttachment } = usePromptInput();
  const { pickImage } = useImagePicker();
  const { pickDocument } = useDocumentPicker();

  const handleAddPhotos = async () => {
    try {
      const assets = await pickImage();
      if (assets && assets.length > 0) {
        assets.forEach((asset) => {
          addAttachment({
            id: `img-${Date.now()}-${Math.random().toString(36).slice(2)}`,
            uri: asset.uri,
            type: "image",
            name: asset.name,
            size: asset.size,
            mimeType: asset.mimeType,
          });
        });
      }
    } catch (err) {
      console.error("Error picking images:", err);
    }
  };

  const handleAddDocument = async () => {
    try {
      const docs = await pickDocument();
      if (docs && docs.length > 0) {
        docs.forEach((doc) => {
          addAttachment({
            id: `doc-${Date.now()}-${Math.random().toString(36).slice(2)}`,
            uri: doc.uri,
            type: "document",
            name: doc.name,
            size: doc.size,
            mimeType: doc.mimeType,
          });
        });
      }
    } catch (err) {
      console.error("Error picking documents:", err);
    }
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
        >
          <Plus size={iconSize} className="text-muted-foreground" />
        </Button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Content side="top" align="start">
        <DropdownMenu.Item key="photos" onSelect={handleAddPhotos}>
          <DropdownMenu.ItemIcon ios={{ name: "photo" }} />
          <DropdownMenu.ItemTitle>Add photos</DropdownMenu.ItemTitle>
        </DropdownMenu.Item>
        <DropdownMenu.Item key="document" onSelect={handleAddDocument}>
          <DropdownMenu.ItemIcon ios={{ name: "doc" }} />
          <DropdownMenu.ItemTitle>Add document</DropdownMenu.ItemTitle>
        </DropdownMenu.Item>
      </DropdownMenu.Content>
    </DropdownMenu.Root>
  );
}
