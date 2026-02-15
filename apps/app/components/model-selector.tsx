import { ChevronDown, Lock } from "lucide-react-native";
import * as DropdownMenu from "@/components/ui/dropdown-menu";
import { Pressable, View, Platform } from "react-native";
import { Text } from "@/components/ui/text";
import { useState, useEffect, useMemo } from "react";
import { useRouter } from "expo-router";
import config from "@/lib/config";
import { useEntitlements } from "@/lib/hooks/use-billing";
import { toast } from "@/components/sonner";
import { useTranslation } from "@/hooks/useTranslation";

interface Model {
  id: string;
  name: string;
  description: string;
  requiredPlan: string | null;
  isLegacy: boolean;
}

// Cache models in memory (they don't change frequently)
let cachedModels: Model[] | null = null;

/** Returns the latest thinking model ID from cached models, or a fallback. */
export function getThinkingModelId(): string {
  if (cachedModels) {
    const thinkingModels = cachedModels.filter(m => m.id.includes('thinking'));
    if (thinkingModels.length > 0) {
      return thinkingModels[thinkingModels.length - 1].id;
    }
  }
  return 'alia-v1-thinking';
}

/** Check if a model ID is a thinking model. */
export function isThinkingModel(modelId: string): boolean {
  return modelId.includes('thinking');
}

interface ModelSelectorProps {
  selectedModel?: string;
  onModelChange?: (modelId: string) => void;
}

function ModelCheckboxItem({
  model,
  selected,
  isLocked,
  onSelect,
}: {
  model: Model;
  selected: boolean;
  isLocked: boolean;
  onSelect: () => void;
}) {
  return (
    <DropdownMenu.CheckboxItem
      key={model.id}
      value={selected ? 'on' : 'off'}
      onValueChange={onSelect}
    >
      {Platform.OS === 'web' ? (
        <View className={`flex-col gap-0.5 flex-1 ${isLocked ? 'opacity-50' : ''}`}>
          <View className="flex-row items-center gap-1.5">
            <Text className="text-sm font-medium text-foreground">
              {model.name}
            </Text>
            {isLocked && <Lock size={11} className="text-muted-foreground" />}
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
            {isLocked ? '🔒 ' : ''}{model.name}{model.requiredPlan ? ` (${model.requiredPlan})` : ''}
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
  const { data: entitlements } = useEntitlements();
  const router = useRouter();
  const { t } = useTranslation();
  const allowedIds = useMemo(
    () => new Set(entitlements?.allowedModelIds || ['alia-lite', 'alia-v1', 'alia-v1-audio']),
    [entitlements],
  );

  useEffect(() => {
    setValue(selectedModel);
  }, [selectedModel]);

  useEffect(() => {
    if (!cachedModels) {
      fetch(`${config.apiUrl}/v1/models?chat=true`)
        .then((res) => res.json())
        .then((data) => {
          const fetchedModels = data.data
            ?.map((m: any) => ({
              id: m.id,
              name: m.name,
              description: m.description,
              requiredPlan: m.required_plan ?? null,
              isLegacy: m.is_legacy ?? false,
            })) || [];
          cachedModels = fetchedModels;
          setModels(fetchedModels);
          setLoading(false);
        })
        .catch((error) => {
          console.error('[ModelSelector] Error fetching models:', error);
          cachedModels = [
            { id: "alia-v1", name: "Alia V1", description: "Balanced performance", requiredPlan: null, isLegacy: false },
          ];
          setModels(cachedModels);
          setLoading(false);
        });
    }
  }, []);

  const handleValueChange = (modelId: string) => {
    if (!allowedIds.has(modelId)) {
      const model = models.find(m => m.id === modelId);
      toast.info(t('subscribe.modelRequiresPlan', { plan: model?.requiredPlan || 'Go' }));
      router.push('/(biglayout)/subscribe');
      return;
    }
    setValue(modelId);
    onModelChange?.(modelId);
  };

  const currentModel = models.find((m) => m.id === value);

  const { regularModels, legacyModels } = useMemo(() => ({
    regularModels: models.filter(m => !m.isLegacy),
    legacyModels: models.filter(m => m.isLegacy),
  }), [models]);

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
            {regularModels.map((model) => (
              <ModelCheckboxItem
                key={model.id}
                model={model}
                selected={value === model.id}
                isLocked={!allowedIds.has(model.id)}
                onSelect={() => handleValueChange(model.id)}
              />
            ))}
            {legacyModels.length > 0 && (
              <>
                <DropdownMenu.Separator />
                <DropdownMenu.Sub>
                  <DropdownMenu.SubTrigger>
                    <DropdownMenu.ItemTitle>Legacy models</DropdownMenu.ItemTitle>
                  </DropdownMenu.SubTrigger>
                  <DropdownMenu.SubContent className="w-64">
                    {legacyModels.map((model) => (
                      <ModelCheckboxItem
                        key={model.id}
                        model={model}
                        selected={value === model.id}
                        isLocked={!allowedIds.has(model.id)}
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
