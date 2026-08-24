import { useState } from "react";
import { View, Platform } from "react-native";
import { Text } from "@/components/ui/text";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Button } from "@/components/ui/button";
import { SettingsListGroup, SettingsListItem } from "@oxyhq/bloom/settings-list";
import { useTheme } from "@oxyhq/bloom/theme";
import { HardDrive, Cpu, RefreshCw } from "lucide-react-native";
import { useTranslation } from "@/lib/hooks/use-translation";
import { useLocalRuntimeStore, DEFAULT_LOCAL_ENDPOINT } from "@/lib/stores/local-runtime-store";
import { useLocalRuntimeProbe } from "@/lib/hooks/use-local-runtime";

/** The origin Ollama has to be told to accept, quoted back as a runnable command. */
function browserOrigin(): string {
  if (Platform.OS !== "web" || typeof window === "undefined") return "";
  return window.location.origin;
}

/** Safari is the one desktop browser that refuses a localhost request from an https page. */
function isSafari(): boolean {
  if (Platform.OS !== "web" || typeof navigator === "undefined") return false;
  return /^((?!chrome|android|chromium).)*safari/i.test(navigator.userAgent);
}

export function LocalModelsSection() {
  const { t } = useTranslation();
  const { colors } = useTheme();

  const enabled = useLocalRuntimeStore((state) => state.enabled);
  const endpoint = useLocalRuntimeStore((state) => state.endpoint);
  const label = useLocalRuntimeStore((state) => state.label);
  const setEnabled = useLocalRuntimeStore((state) => state.setEnabled);
  const setEndpoint = useLocalRuntimeStore((state) => state.setEndpoint);
  const setLabel = useLocalRuntimeStore((state) => state.setLabel);

  // Held locally while typing so a half-typed URL never becomes the live one —
  // the store's value is what the serving hook dials on the next turn.
  const [draftEndpoint, setDraftEndpoint] = useState(endpoint);

  const probe = useLocalRuntimeProbe();
  const models = probe.data ?? [];
  const failure = probe.error instanceof Error ? probe.error : null;
  const origin = browserOrigin();

  return (
    <View className="gap-5">
      <Text className="text-sm text-muted-foreground">{t("settings.localModels.description")}</Text>

      <SettingsListGroup>
        <SettingsListItem
          icon={<HardDrive size={18} color={colors.primary} />}
          title={t("settings.localModels.enable")}
          description={t("settings.localModels.enableHint")}
          showChevron={false}
          rightElement={<Switch value={enabled} onValueChange={setEnabled} size="sm" />}
        />
      </SettingsListGroup>

      {enabled ? (
        <View className="gap-5">
          <View className="gap-2">
            <Text className="text-sm font-medium text-foreground">{t("settings.localModels.endpoint")}</Text>
            <Input
              value={draftEndpoint}
              onChangeText={setDraftEndpoint}
              onBlur={() => setEndpoint(draftEndpoint.trim() || DEFAULT_LOCAL_ENDPOINT)}
              autoCapitalize="none"
              autoCorrect={false}
              placeholder={DEFAULT_LOCAL_ENDPOINT}
            />
            <Text className="text-xs text-muted-foreground">{t("settings.localModels.endpointHint")}</Text>
          </View>

          <View className="gap-2">
            <Text className="text-sm font-medium text-foreground">{t("settings.localModels.deviceName")}</Text>
            <Input
              value={label}
              onChangeText={setLabel}
              autoCapitalize="none"
              autoCorrect={false}
              placeholder={t("settings.localModels.deviceName")}
            />
            <Text className="text-xs text-muted-foreground">{t("settings.localModels.deviceNameHint")}</Text>
          </View>

          <View className="flex-row items-center gap-3">
            <Button
              variant="outline"
              size="sm"
              onPress={() => {
                setEndpoint(draftEndpoint.trim() || DEFAULT_LOCAL_ENDPOINT);
                void probe.refetch();
              }}
              disabled={probe.isFetching}
            >
              <View className="flex-row items-center gap-2">
                <RefreshCw size={14} className="text-foreground" />
                <Text className="text-xs">
                  {probe.isFetching ? t("settings.localModels.testing") : t("settings.localModels.test")}
                </Text>
              </View>
            </Button>
            <Text className={`text-xs ${models.length > 0 ? "text-foreground" : "text-muted-foreground"}`}>
              {models.length > 0
                ? t("settings.localModels.connected", { count: models.length })
                : t("settings.localModels.notConnected")}
            </Text>
          </View>

          {failure ? (
            <View className="gap-2 rounded-xl border border-border bg-muted/40 p-3">
              <Text className="text-xs text-destructive">{failure.message}</Text>
              {/* The two reasons a reachable server still refuses a browser. Shown
                  on failure rather than always, so a working setup stays quiet. */}
              {origin ? (
                <Text className="text-xs text-muted-foreground">
                  {t("settings.localModels.corsHint", { origin })}
                </Text>
              ) : null}
              {isSafari() ? (
                <Text className="text-xs text-muted-foreground">{t("settings.localModels.safariHint")}</Text>
              ) : null}
            </View>
          ) : null}

          {models.length > 0 ? (
            <SettingsListGroup title={t("settings.localModels.modelsTitle")}>
              {models.map((model) => (
                <SettingsListItem
                  key={model}
                  icon={<Cpu size={18} color={colors.primary} />}
                  title={model}
                  showChevron={false}
                  rightElement={
                    <Text className="text-xs text-muted-foreground">{t("settings.localModels.free")}</Text>
                  }
                />
              ))}
            </SettingsListGroup>
          ) : null}

          <Text className="text-xs text-muted-foreground">{t("settings.localModels.freeNote")}</Text>
        </View>
      ) : null}
    </View>
  );
}
