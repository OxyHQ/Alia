import React from "react";
import { Plus } from "lucide-react-native";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import * as DropdownMenu from "@/components/ui/dropdown-menu";
import { useImagePicker } from "@/hooks/useImagePicker";
import { useDocumentPicker } from "@/hooks/useDocumentPicker";
import { usePromptInput } from "./context";

export type PromptInputAddMenuProps = {
  className?: string;
};

export function PromptInputAddMenu({ className }: PromptInputAddMenuProps) {
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
          variant="outline"
          size="icon"
          className={cn("h-8 w-8 rounded-full border-0", className)}
        >
          <Plus size={16} className="text-muted-foreground" />
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
