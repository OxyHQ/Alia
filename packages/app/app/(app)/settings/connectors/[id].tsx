import {
  View,
  ScrollView,
  Pressable,
  ActivityIndicator,
  Platform,
  Linking,
  StyleSheet,
} from "react-native";
import { Image } from "expo-image";
import { LinearGradient } from "expo-linear-gradient";
import { useLocalSearchParams, useRouter } from "expo-router";
import { useState } from "react";
import {
  ChevronLeft,
  Plug,
  Check,
  ArrowUp,
  ExternalLink,
} from "lucide-react-native";
import { confirm } from "@oxyhq/bloom/alert-dialog";
import { withAlpha } from "@oxyhq/bloom/theme";
import { Text } from "@/components/ui/text";
import { Button } from "@/components/ui/button";
import { SettingsHeader } from "@/components/settings/settings-header";
import { useMcpServers } from "@/lib/hooks/use-mcp-servers";
import { toast } from "@/components/sonner";
import { useColorScheme } from "@/lib/useColorScheme";
import { useTranslation } from "@/lib/hooks/use-translation";

function isImageUrl(icon?: string): boolean {
  return !!icon && /^https?:\/\//i.test(icon);
}

// A tool name implies write access when it reads as a mutation verb.
const WRITE_VERB = /create|write|update|delete|send|post|add|remove|edit|set/i;

export default function ConnectorDetailScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const { t } = useTranslation();
  const { colors } = useColorScheme();

  const { registry, installed, loading, install, uninstall, startOAuth } =
    useMcpServers();

  const [pending, setPending] = useState(false);

  const entry = registry.find((e) => e.id === id);
  const server = installed.find((s) => s.registryId === id);

  const goBack = () => router.push("/(app)/settings/connectors");

  const handleConnect = async () => {
    if (!entry) return;
    setPending(true);
    try {
      // Reuse an existing install if the user connected before; otherwise create
      // the McpServer so the backend has a serverId to bind the OAuth state to.
      const existing = installed.find((s) => s.registryId === entry.id);
      const srv = existing ?? (await install(entry.id));
      const url = await startOAuth(srv._id);
      if (Platform.OS === "web") {
        // Top-level navigation so the provider callback returns with the
        // ?mcp_oauth_state=&mcp_oauth_code= params the catalog screen consumes.
        window.location.href = url;
      } else {
        await Linking.openURL(url);
      }
    } catch (err) {
      console.error("Failed to start connector OAuth:", err);
      toast.error(t("connectors.connectFailed"));
    } finally {
      setPending(false);
    }
  };

  const handleInstall = async () => {
    if (!entry) return;
    setPending(true);
    try {
      await install(entry.id);
      toast.success(t("connectors.installedToast", { name: entry.name }));
    } catch {
      toast.error(t("connectors.installFailed"));
    } finally {
      setPending(false);
    }
  };

  const handleUninstall = async () => {
    if (!server || !entry) return;
    const ok = await confirm({
      title: t("connectors.uninstallTitle"),
      description: t("connectors.uninstallDescription", { name: entry.name }),
      confirmLabel: t("connectors.uninstall"),
      cancelLabel: t("common.cancel"),
      destructive: true,
    });
    if (!ok) return;
    setPending(true);
    try {
      await uninstall(server._id);
      toast.success(t("connectors.uninstalledToast", { name: entry.name }));
    } catch {
      toast.error(t("connectors.uninstallFailed"));
    } finally {
      setPending(false);
    }
  };

  if (loading) {
    return (
      <View className="flex-1 bg-background">
        <SettingsHeader title={t("connectors.detailTitle")} />
        <View className="flex-1 items-center justify-center py-12">
          <ActivityIndicator size="small" />
        </View>
      </View>
    );
  }

  if (!entry) {
    return (
      <View className="flex-1 bg-background">
        <SettingsHeader title={t("connectors.detailTitle")} />
        <View className="flex-1 items-center justify-center gap-4 py-12">
          <Text className="text-muted-foreground">
            {t("connectors.notFound")}
          </Text>
          <Button variant="outline" size="sm" onPress={goBack}>
            <Text className="text-sm">{t("connectors.back")}</Text>
          </Button>
        </View>
      </View>
    );
  }

  const requiresOAuth = !!entry.requiresOAuth;
  const needsEnv = entry.requiredEnv.length > 0;
  // "Connected" requires the OAuth flow to have completed (server running) —
  // an installed-but-not-yet-authorized OAuth connector is NOT connected. A
  // non-OAuth (stdio) connector is done once installed.
  const connected = !!server && (requiresOAuth ? server.status === "running" : true);
  const tools = server?.tools ?? [];
  const hasWriteTool = tools.some((tl) => WRITE_VERB.test(tl.name));
  const capabilities = hasWriteTool ? "Read, Write" : "Read";
  const authValue = requiresOAuth ? "OAuth" : needsEnv ? "API key" : "None";

  const websiteUrl = entry.url;
  let websiteHost: string | null = null;
  if (websiteUrl) {
    try {
      websiteHost = new URL(websiteUrl).host;
    } catch {
      websiteHost = websiteUrl;
    }
  }

  return (
    <View className="flex-1 bg-background">
      <SettingsHeader title={entry.name} />
      <ScrollView className="flex-1" contentContainerClassName="p-5 max-w-2xl">
        <View className="gap-6">
          {/* 1. Back link */}
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={t("connectors.back")}
            onPress={goBack}
            className="flex-row items-center gap-1 self-start active:opacity-70 web:hover:opacity-80"
          >
            <ChevronLeft size={16} className="text-muted-foreground" />
            <Text className="text-sm text-muted-foreground">
              {t("connectors.back")}
            </Text>
          </Pressable>

          {/* 2. Hero */}
          <View className="flex-row items-start gap-4">
            <View className="size-14 rounded-[14px] bg-background border border-border items-center justify-center overflow-hidden">
              {isImageUrl(entry.icon) ? (
                <Image
                  source={{ uri: entry.icon }}
                  style={{ width: 30, height: 30 }}
                  contentFit="contain"
                />
              ) : (
                <Plug size={30} className="text-muted-foreground" />
              )}
            </View>
            <View className="flex-1 min-w-0">
              <Text className="text-[28px] leading-[34px] font-medium tracking-tight text-foreground">
                {entry.name}
              </Text>
              <Text className="text-[14px] leading-[18px] text-muted-foreground mt-2 max-w-[520px]">
                {entry.description}
              </Text>
            </View>
            {/* Primary action */}
            {connected ? (
              <View className="flex-row items-center gap-2 shrink-0">
                <View className="flex-row items-center gap-1.5 h-9 px-3 rounded-full bg-muted">
                  <Check size={15} className="text-foreground" />
                  <Text className="text-sm text-foreground">
                    {t("connectors.connected")}
                  </Text>
                </View>
                <Button
                  variant="outline"
                  size="sm"
                  className="h-9"
                  onPress={handleUninstall}
                  disabled={pending}
                >
                  <Text className="text-sm">{t("connectors.uninstall")}</Text>
                </Button>
              </View>
            ) : server && requiresOAuth ? (
              // Installed but the OAuth flow hasn't completed — let the user
              // finish/retry it, or remove the pending connector.
              <View className="flex-row items-center gap-2 shrink-0">
                <Button onPress={handleConnect} isLoading={pending}>
                  <Text className="text-sm">{t("connectors.connect")}</Text>
                </Button>
                <Button variant="outline" size="sm" className="h-9" onPress={handleUninstall} disabled={pending}>
                  <Text className="text-sm">{t("connectors.uninstall")}</Text>
                </Button>
              </View>
            ) : requiresOAuth ? (
              <Button className="shrink-0" onPress={handleConnect} isLoading={pending}>
                <Text className="text-sm">{t("connectors.connect")}</Text>
              </Button>
            ) : needsEnv ? (
              <Text className="text-[13px] text-muted-foreground max-w-[160px] text-right shrink-0">
                {t("connectors.installFromList")}
              </Text>
            ) : (
              <Button className="shrink-0" onPress={handleInstall} isLoading={pending}>
                <Text className="text-sm">{t("connectors.install")}</Text>
              </Button>
            )}
          </View>

          {/* 3. Default-prompt preview */}
          <View className="rounded-[20px] overflow-hidden border border-border">
            <View className="py-16 px-5 items-center">
              <LinearGradient
                colors={[
                  withAlpha(colors.primary, 0.16),
                  withAlpha(colors.primary, 0.05),
                  withAlpha(colors.surface, 0),
                ]}
                start={{ x: 0, y: 0 }}
                end={{ x: 1, y: 1 }}
                style={StyleSheet.absoluteFill}
              />
              <View className="rounded-full bg-background/80 border border-border px-4 py-2 flex-row items-center gap-3">
                <Text className="text-sm text-foreground">
                  <Text className="font-semibold">@{entry.name}</Text>
                  {" "}
                  {t("connectors.examplePrompt")}
                </Text>
                <View className="size-7 rounded-full bg-foreground items-center justify-center">
                  <ArrowUp size={14} className="text-background" />
                </View>
              </View>
            </View>
          </View>

          {/* 4. About */}
          <Text className="text-sm leading-[18px] text-muted-foreground">
            {entry.description}
          </Text>

          {/* 5. Skills */}
          <View className="gap-3">
            <Text className="text-base leading-[26px] font-medium text-foreground">
              {t("connectors.skills")}
            </Text>
            {tools.length > 0 ? (
              <View className="flex-row flex-wrap gap-2">
                {tools.map((tl) => (
                  <View
                    key={tl.name}
                    className="flex-row items-center gap-1 rounded-full border border-border px-3 h-9"
                  >
                    <Text className="text-sm text-foreground">{tl.name}</Text>
                  </View>
                ))}
              </View>
            ) : (
              <Text className="text-sm text-muted-foreground">
                {t("connectors.connectToSeeTools")}
              </Text>
            )}
          </View>

          {/* 6. Information */}
          <View className="gap-3">
            <Text className="text-base leading-[26px] font-medium text-foreground">
              {t("connectors.information")}
            </Text>
            <View className="border-t border-border">
              <View className="flex-row py-3 border-b border-border">
                <Text className="w-36 text-sm text-muted-foreground">
                  {t("connectors.capabilities")}
                </Text>
                <Text className="flex-1 text-sm text-foreground">
                  {capabilities}
                </Text>
              </View>
              <View className="flex-row py-3 border-b border-border">
                <Text className="w-36 text-sm text-muted-foreground">
                  {t("connectors.transport")}
                </Text>
                <Text className="flex-1 text-sm text-foreground">
                  {entry.transport}
                </Text>
              </View>
              <View className="flex-row py-3 border-b border-border">
                <Text className="w-36 text-sm text-muted-foreground">
                  {t("connectors.authentication")}
                </Text>
                <Text className="flex-1 text-sm text-foreground">
                  {authValue}
                </Text>
              </View>
              {websiteUrl ? (
                <View className="flex-row py-3 border-b border-border">
                  <Text className="w-36 text-sm text-muted-foreground">
                    {t("connectors.website")}
                  </Text>
                  <Pressable
                    accessibilityRole="link"
                    onPress={() => Linking.openURL(websiteUrl)}
                    className="flex-1 flex-row items-center gap-1 active:opacity-70"
                  >
                    <Text className="text-sm text-primary" numberOfLines={1}>
                      {websiteHost}
                    </Text>
                    <ExternalLink size={13} className="text-primary" />
                  </Pressable>
                </View>
              ) : null}
              {server ? (
                <View className="flex-row py-3 border-b border-border">
                  <Text className="w-36 text-sm text-muted-foreground">
                    {t("connectors.status")}
                  </Text>
                  <Text className="flex-1 text-sm text-foreground capitalize">
                    {server.status}
                  </Text>
                </View>
              ) : null}
            </View>
          </View>
        </View>
      </ScrollView>
    </View>
  );
}
