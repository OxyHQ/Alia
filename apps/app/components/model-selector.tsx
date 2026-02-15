import { ChevronDown } from "lucide-react-native";
import * as DropdownMenu from "@/components/ui/dropdown-menu";
import { Pressable, View, Platform } from "react-native";
import { Text } from "@/components/ui/text";
import { useState, useEffect, useMemo } from "react";
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

const MAX_TOP_LEVEL_MODELS = 5;

function ModelCheckboxItem({
  model,
  selected,
  onSelect,
}: {
  model: Model;
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <DropdownMenu.CheckboxItem
      key={model.id}
      value={selected ? 'on' : 'off'}
      onValueChange={onSelect}
    >
      {Platform.OS === 'web' ? (
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
      ) : (
        <>
          <DropdownMenu.ItemIndicator />
          <DropdownMenu.ItemTitle>
            {model.name}{model.requiredPlan ? ` (${model.requiredPlan})` : ''}
          </DropdownMenu.ItemTitle>
          <DropdownMenu.ItemSubtitle>{model.description}</DropdownMenu.ItemSubtitle>
        </>
      )}
    </DropdownMenu.CheckboxItem>
  );
}

export function ModelSelector({
  selectedModel = "alia-v1",
  onModelChange,
}: ModelSelectorProps) {
  const [value, setValue] = useState(selectedModel);
  const [models, setModels] = useState<Model[]>(cachedModels || []);
  const [loading, setLoading] = useState(!cachedModels);

  useEffect(() => {
    setValue(selectedModel);
  }, [selectedModel]);

  useEffect(() => {
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

  const handleValueChange = (modelId: string) => {
    setValue(modelId);
    onModelChange?.(modelId);
  };

  const currentModel = models.find((m) => m.id === value);

  const { primaryModels, moreModels } = useMemo(() => {
    if (models.length <= MAX_TOP_LEVEL_MODELS) {
      return { primaryModels: models, moreModels: [] };
    }
    return {
      primaryModels: models.slice(0, MAX_TOP_LEVEL_MODELS),
      moreModels: models.slice(MAX_TOP_LEVEL_MODELS),
    };
  }, [models]);

  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger>
        <Pressable className="flex-row items-center gap-1.5 px-3 py-1.5 rounded-full bg-muted active:opacity-70">
          <Text className="text-sm font-medium text-foreground">
            {currentModel?.name || "Alia V1"}
          </Text>
          <ChevronDown size={14} className="text-muted-foreground" />
        </Pressable>
      </DropdownMenu.Trigger>
      <DropdownMenu.Content align="start" className="w-64">
        <DropdownMenu.Label className="text-xs text-muted-foreground font-normal px-2.5">Select Model</DropdownMenu.Label>
        {loading ? (
          <DropdownMenu.Item key="loading" disabled>
            <DropdownMenu.ItemTitle>Loading models...</DropdownMenu.ItemTitle>
          </DropdownMenu.Item>
        ) : (
          <>
            {primaryModels.map((model) => (
              <ModelCheckboxItem
                key={model.id}
                model={model}
                selected={value === model.id}
                onSelect={() => handleValueChange(model.id)}
              />
            ))}
            {moreModels.length > 0 && (
              <>
                <DropdownMenu.Separator />
                <DropdownMenu.Sub>
                  <DropdownMenu.SubTrigger>
                    <DropdownMenu.ItemIcon ios={{ name: "sparkle" }} />
                    <DropdownMenu.ItemTitle>More models</DropdownMenu.ItemTitle>
                  </DropdownMenu.SubTrigger>
                  <DropdownMenu.SubContent>
                    {moreModels.map((model) => (
                      <ModelCheckboxItem
                        key={model.id}
                        model={model}
                        selected={value === model.id}
                        onSelect={() => handleValueChange(model.id)}
                      />
                    ))}
                  </DropdownMenu.SubContent>
                </DropdownMenu.Sub>
              </>
            )}
          </>
        )}
      </DropdownMenu.Content>
    </DropdownMenu.Root>
  );
}
