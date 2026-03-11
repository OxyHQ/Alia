import React, { useState, useEffect } from "react";
import { View, Pressable, ScrollView } from "react-native";
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
  FolderOpen,
  Briefcase,
  Folder,
  Package,
  Rocket,
  Target,
  Lightbulb,
  Star,
  Heart,
  Zap,
  type LucideIcon,
} from "lucide-react-native";
import { cn } from "@/lib/utils";
import type { Project } from "@/lib/stores/projects-store";

const ICON_OPTIONS = [
  { name: "FolderOpen", Icon: FolderOpen },
  { name: "Briefcase", Icon: Briefcase },
  { name: "Folder", Icon: Folder },
  { name: "Package", Icon: Package },
  { name: "Rocket", Icon: Rocket },
  { name: "Target", Icon: Target },
  { name: "Lightbulb", Icon: Lightbulb },
  { name: "Star", Icon: Star },
  { name: "Heart", Icon: Heart },
  { name: "Zap", Icon: Zap },
];

const COLOR_OPTIONS = [
  "#3b82f6", // blue
  "#8b5cf6", // purple
  "#ec4899", // pink
  "#f59e0b", // amber
  "#10b981", // green
  "#06b6d4", // cyan
  "#f97316", // orange
  "#ef4444", // red
];

interface ProjectEditDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  project?: Project | null;
  onSave: (data: { name: string; description?: string; icon?: string; color?: string }) => void;
}

export const ProjectEditDialog = ({
  open,
  onOpenChange,
  project,
  onSave,
}: ProjectEditDialogProps) => {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [selectedIcon, setSelectedIcon] = useState("FolderOpen");
  const [selectedColor, setSelectedColor] = useState(COLOR_OPTIONS[0]);

  useEffect(() => {
    if (project) {
      setName(project.name);
      setDescription(project.description || "");
      setSelectedIcon(project.icon || "FolderOpen");
      setSelectedColor(project.color || COLOR_OPTIONS[0]);
    } else {
      setName("");
      setDescription("");
      setSelectedIcon("FolderOpen");
      setSelectedColor(COLOR_OPTIONS[0]);
    }
  }, [project, open]);

  const handleSave = () => {
    if (!name.trim()) return;

    onSave({
      name: name.trim(),
      description: description.trim() || undefined,
      icon: selectedIcon,
      color: selectedColor,
    });

    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{project ? "Edit Project" : "New Project"}</DialogTitle>
          <DialogDescription>
            {project
              ? "Update your project details"
              : "Create a new project to organize your conversations"}
          </DialogDescription>
        </DialogHeader>

        <View className="gap-4">
          {/* Name Input */}
          <View className="gap-2">
            <Text className="text-sm font-medium text-foreground">Name</Text>
            <Input
              value={name}
              onChangeText={setName}
              placeholder="Project name"
              className="h-11"
            />
          </View>

          {/* Description Input */}
          <View className="gap-2">
            <Text className="text-sm font-medium text-foreground">
              Description (optional)
            </Text>
            <Input
              value={description}
              onChangeText={setDescription}
              placeholder="Project description"
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
          <View className="gap-2">
            <Text className="text-sm font-medium text-foreground">Color</Text>
            <View className="flex-row flex-wrap gap-2">
              {COLOR_OPTIONS.map((color) => (
                <Pressable
                  key={color}
                  onPress={() => setSelectedColor(color)}
                  className={cn(
                    "h-10 w-10 rounded-full border-2 overflow-hidden",
                    selectedColor === color
                      ? "border-foreground scale-110"
                      : "border-transparent"
                  )}
                >
                  <View style={{ backgroundColor: color, flex: 1 }} />
                </Pressable>
              ))}
            </View>
          </View>
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
              {project ? "Save" : "Create"}
            </Text>
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};
