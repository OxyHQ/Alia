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
import { useLocalRuntimeProbe, LocalRuntimeProbeError } from "@/lib/hooks/use-local-runtime";

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

  const consent = useLocalRuntimeStore((state) => state.consent);
  const endpoint = useLocalRuntimeStore((state) => state.endpoint);
  const label = useLocalRuntimeStore((state) => state.label);
  const setConsent = useLocalRuntimeStore((state) => state.setConsent);
  const setEndpoint = useLocalRuntimeStore((state) => state.setEndpoint);
  const setLabel = useLocalRuntimeStore((state) => state.setLabel);

  // Held locally while typing so a half-typed URL never becomes the live one —
  // the store's value is what the serving hook dials on the next turn.
  const [draftEndpoint, setDraftEndpoint] = useState(endpoint);

  const probe = useLocalRuntimeProbe();
  const models = probe.data ?? [];
  const origin = browserOrigin();

  /**
   * What went wrong, said in terms the person can act on.
   *
   * `Failed to fetch` is the browser's answer to two different problems and it
   * is the one string it gives for both, so the probe classifies them and this
   * only renders the classification. An unrecognised error keeps its own
   * message rather than being forced into one of the buckets.
   */
  const failure = probe.error instanceof LocalRuntimeProbeError ? probe.error : null;
  const unknownFailure = probe.error instanceof Error && failure === null ? probe.error : null;
  const failureText =
    failure === null
      ? null
      : failure.reason === 'unreachable'
        ? t("settings.localModels.unreachable", { endpoint })
        : failure.reason === 'refused'
          ? t("settings.localModels.refused", { endpoint })
          : failure.reason === 'http'
            ? t("settings.localModels.httpError", { status: failure.status })
            : t("settings.localModels.empty");

  return (
    <View className="gap-5">
      <Text className="text-sm text-muted-foreground">{t("settings.localModels.description")}</Text>

      <SettingsListGroup>
        <SettingsListItem
          icon={<HardDrive size={18} color={colors.primary} />}
          title={t("settings.localModels.enable")}
          description={t("settings.localModels.enableHint")}
          showChevron={false}
          rightElement={
            <Switch
              // Three stored states, one control: `unasked` reads as off, and
              // touching it is an answer either way — which is what makes this
              // the escape hatch for someone who declined the card and changed
              // their mind.
              value={consent === "granted"}
              onValueChange={(on) => setConsent(on ? "granted" : "declined")}
              size="sm"
            />
          }
        />
      </SettingsListGroup>

      {consent === "granted" ? (
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

          {failureText !== null || unknownFailure !== null ? (
            <View className="gap-2 rounded-xl border border-border bg-muted/40 p-3">
              <Text className="text-xs text-destructive">
                {failureText ?? unknownFailure?.message}
              </Text>

              {failure?.reason === 'unreachable' ? (
                <Text className="text-xs text-muted-foreground">
                  {t("settings.localModels.unreachableHint")}
                </Text>
              ) : null}

              {/* The command, not a sentence describing it. A person who has to
                  retype an env var from prose gets it wrong once and concludes
                  the feature is broken. `selectable` so it can be copied. */}
              {failure?.reason === 'refused' && origin ? (
                <View className="gap-1.5">
                  <Text className="text-xs text-muted-foreground">
                    {t("settings.localModels.refusedHint")}
                  </Text>
                  <Text
                    selectable
                    className="rounded-lg bg-background px-2.5 py-2 font-mono text-xs text-foreground"
                  >
                    {t("settings.localModels.command", { origin })}
                  </Text>
                </View>
              ) : null}

              {/* Safari fails BEFORE either case above can be told apart: it
                  refuses an http request from an https page outright, so the
                  probe reports `unreachable` however healthy the server is.
                  Shown whenever this is Safari, not only on one reason. */}
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
