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
import { useState, useEffect } from "react";
import config from "@/lib/config";

interface Model {
  id: string;
  name: string;
  description: string;
  requiredPlan: string | null;
}

// Cache models in memory (they don't change frequently)
let cachedModels: Model[] | null = null;

interface ModelSelectorProps {
  selectedModel?: string;
  onModelChange?: (modelId: string) => void;
}

export function ModelSelector({
  selectedModel = "alia-v1",
  onModelChange,
}: ModelSelectorProps) {
  const [value, setValue] = useState(selectedModel);
  const [models, setModels] = useState<Model[]>(cachedModels || []);
  const [loading, setLoading] = useState(!cachedModels);

  useEffect(() => {
    // Only fetch if not cached
    if (!cachedModels) {
      fetch(`${config.apiUrl}/v1/models`)
        .then((res) => res.json())
        .then((data) => {
          const fetchedModels = data.data
            ?.map((m: any) => ({
              id: m.id,
              name: m.name,
              description: m.description,
              requiredPlan: m.required_plan ?? null,
            })) || [];
          cachedModels = fetchedModels;
          setModels(fetchedModels);
          setLoading(false);
        })
        .catch((error) => {
          console.error('[ModelSelector] Error fetching models:', error);
          cachedModels = [
            { id: "alia-v1", name: "Alia V1", description: "Balanced performance", requiredPlan: null },
          ];
          setModels(cachedModels);
          setLoading(false);
        });
    }
  }, []);

  const handleValueChange = (newValue: string) => {
    setValue(newValue);
    onModelChange?.(newValue);
  };

  const currentModel = models.find((m) => m.id === value);

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
      <DropdownMenuContent align="end" className="w-64">
        <DropdownMenuLabel className="text-xs text-muted-foreground font-normal px-2.5">
          Select Model
        </DropdownMenuLabel>
        <DropdownMenuRadioGroup value={value} onValueChange={handleValueChange}>
          {loading ? (
            <View className="py-4 items-center">
              <Text className="text-sm text-muted-foreground">Loading models...</Text>
            </View>
          ) : (
            models.map((model) => (
              <DropdownMenuRadioItem key={model.id} value={model.id} className="py-2.5">
                <View className="flex-col gap-0.5 flex-1">
                  <View className="flex-row items-center gap-1.5">
                    <Text className="text-sm font-medium text-foreground">
                      {model.name}
                    </Text>
                    {model.requiredPlan && (
                      <View className="bg-primary/10 px-1.5 py-0.5 rounded-full">
                        <Text className="text-[10px] font-semibold text-primary">
                          {model.requiredPlan}
                        </Text>
                      </View>
                    )}
                  </View>
                  <Text className="text-xs text-muted-foreground">
                    {model.description}
                  </Text>
                </View>
              </DropdownMenuRadioItem>
            ))
          )}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
