import { Text } from "@/components/ui/text";
import { ChevronDown } from "lucide-react-native";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Pressable, View } from "react-native";
import { useState } from "react";

interface Model {
  id: string;
  name: string;
  description: string;
}

const MODELS: Model[] = [
  {
    id: "alia-v1-lite",
    name: "Alia V1 Lite",
    description: "Lightweight and blazing fast"
  },
  {
    id: "alia-v1",
    name: "Alia V1",
    description: "Fast and efficient model"
  },
  {
    id: "alia-v1-pro",
    name: "Alia V1 Pro",
    description: "Enhanced reasoning and accuracy"
  },
  {
    id: "alia-v1-pro-max",
    name: "Alia V1 Pro Max",
    description: "Maximum performance and capabilities"
  },
];

interface ModelSelectorProps {
  selectedModel?: string;
  onModelChange?: (modelId: string) => void;
}

export function ModelSelector({
  selectedModel = "alia-v1",
  onModelChange,
}: ModelSelectorProps) {
  const [value, setValue] = useState(selectedModel);

  const handleValueChange = (newValue: string) => {
    setValue(newValue);
    onModelChange?.(newValue);
  };

  const currentModel = MODELS.find((m) => m.id === value);

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Pressable className="flex-row items-center gap-1.5 px-3 py-1.5 rounded-full bg-muted active:opacity-70">
          <Text className="text-sm font-medium text-foreground">
            {currentModel?.name || "Alia V1"}
          </Text>
          <ChevronDown size={14} className="text-muted-foreground" />
        </Pressable>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-60">
        <DropdownMenuLabel className="text-xs text-muted-foreground font-normal px-2.5">
          Select Model
        </DropdownMenuLabel>
        <DropdownMenuRadioGroup value={value} onValueChange={handleValueChange}>
          {MODELS.map((model) => (
            <DropdownMenuRadioItem key={model.id} value={model.id} className="py-2.5">
              <View className="flex-col gap-0.5 flex-1">
                <Text className="text-sm font-medium text-foreground">
                  {model.name}
                </Text>
                <Text className="text-xs text-muted-foreground">
                  {model.description}
                </Text>
              </View>
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
