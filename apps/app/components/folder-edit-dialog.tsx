import React, { useState, useEffect } from "react";
import { View, Pressable } from "react-native";
import { Text } from "@/components/ui/text";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Folder,
  FolderOpen,
  Archive,
  Inbox,
  BookMarked,
  FolderClosed,
  type LucideIcon,
} from "lucide-react-native";
import { cn } from "@/lib/utils";
import { ColorPicker, COLOR_OPTIONS } from "@/components/ui/color-picker";
import type { Folder as FolderType } from "@/lib/stores/folders-store";

const ICON_OPTIONS = [
  { name: "Folder", Icon: Folder },
  { name: "FolderOpen", Icon: FolderOpen },
  { name: "FolderClosed", Icon: FolderClosed },
  { name: "Archive", Icon: Archive },
  { name: "Inbox", Icon: Inbox },
  { name: "BookMarked", Icon: BookMarked },
];

interface FolderEditDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  folder?: FolderType | null;
  onSave: (data: { name: string; icon?: string; color?: string }) => void;
}

export const FolderEditDialog = ({
  open,
  onOpenChange,
  folder,
  onSave,
}: FolderEditDialogProps) => {
  const [name, setName] = useState("");
  const [selectedIcon, setSelectedIcon] = useState("Folder");
  const [selectedColor, setSelectedColor] = useState(COLOR_OPTIONS[0]);

  useEffect(() => {
    if (folder) {
      setName(folder.name);
      setSelectedIcon(folder.icon || "Folder");
      setSelectedColor(folder.color || COLOR_OPTIONS[0]);
    } else {
      setName("");
      setSelectedIcon("Folder");
      setSelectedColor(COLOR_OPTIONS[0]);
    }
  }, [folder, open]);

  const handleSave = () => {
    if (!name.trim()) return;

    onSave({
      name: name.trim(),
      icon: selectedIcon,
      color: selectedColor,
    });

    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{folder ? "Edit Folder" : "New Folder"}</DialogTitle>
          <DialogDescription>
            {folder
              ? "Update your folder details"
              : "Create a new folder to organize your conversations"}
          </DialogDescription>
        </DialogHeader>

        <View className="gap-4">
          {/* Name Input */}
          <View className="gap-2">
            <Text className="text-sm font-medium text-foreground">Name</Text>
            <Input
              value={name}
              onChangeText={setName}
              placeholder="Folder name"
              className="h-11"
            />
          </View>

          {/* Icon Picker */}
          <View className="gap-2">
            <Text className="text-sm font-medium text-foreground">Icon</Text>
            <View className="flex-row flex-wrap gap-2">
              {ICON_OPTIONS.map(({ name: iconName, Icon }) => (
                <Pressable
                  key={iconName}
                  onPress={() => setSelectedIcon(iconName)}
                  className={cn(
                    "h-12 w-12 items-center justify-center rounded-lg border-2 transition-colors",
                    selectedIcon === iconName
                      ? "border-primary bg-primary/10"
                      : "border-border bg-muted active:bg-muted/70"
                  )}
                >
                  <Icon
                    size={20}
                    className={cn(
                      selectedIcon === iconName
                        ? "text-primary"
                        : "text-muted-foreground"
                    )}
                  />
                </Pressable>
              ))}
            </View>
          </View>

          {/* Color Picker */}
          <ColorPicker selected={selectedColor} onSelect={setSelectedColor} />
        </View>

        <DialogFooter>
          <Button
            variant="outline"
            onPress={() => onOpenChange(false)}
            className="flex-1"
          >
            <Text>Cancel</Text>
          </Button>
          <Button
            onPress={handleSave}
            className="flex-1"
            disabled={!name.trim()}
          >
            <Text className="text-primary-foreground font-semibold">
              {folder ? "Save" : "Create"}
            </Text>
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};
