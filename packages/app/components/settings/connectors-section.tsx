import {
  View,
  Pressable,
  ActivityIndicator,
  TextInput,
  Platform,
  Linking,
} from "react-native";
import { Image } from "expo-image";
import { useLocalSearchParams, useRouter } from "expo-router";
import { useState, useMemo, useRef, useEffect } from "react";
import { Text } from "@/components/ui/text";
import { Button } from "@/components/ui/button";
import {
  useMcpServers,
  type InstalledMcpServer,
  type McpRegistryEntry,
} from "@/lib/hooks/use-mcp-servers";
import { toast } from "@/components/sonner";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import {
  Collapsible,
  CollapsibleTrigger,
  CollapsibleContent,
} from "@/components/ui/collapsible";
import { Search, Plus, Plug, ChevronDown, Check } from "lucide-react-native";
import { errorStatus } from "@/lib/errors/error-utils";
import { useColorScheme } from "@/lib/useColorScheme";
import { useTranslation } from "@/lib/hooks/use-translation";
import { cn } from "@/lib/utils";

// Ordered registry categories rendered after the Featured section. A featured
// entry appears ONLY in Featured, never duplicated into its category section.
const CATEGORY_ORDER = [
  "productivity",
  "development",
  "communication",
  "data",
  "search",
  "filesystem",
] as const;

function isImageUrl(icon?: string): boolean {
  return !!icon && /^https?:\/\//i.test(icon);
}

function ConnectorIcon({ icon, size = 20 }: { icon?: string; size?: number }) {
  if (isImageUrl(icon)) {
    return (
      <Image
        source={{ uri: icon }}
        style={{ width: size, height: size }}
        contentFit="contain"
      />
    );
  }
  return <Plug size={size} className="text-muted-foreground" />;
}

function InstalledTile({
  server,
  onOpen,
}: {
  server: InstalledMcpServer;
  onOpen?: () => void;
}) {
  // Ref: catalog "Installed" row — size-12 tile, size-10 rounded-xl icon,
  // hover-revealed label on web (always visible on native).
  return (
    <View className="w-14 items-center group">
      {/* Registry-backed tiles open the detail page; custom servers have no
          registry entry to route to, so their tile is inert. */}
      <Pressable
        onPress={onOpen}
        disabled={!onOpen}
        className="size-12 items-center justify-center rounded-[14px] p-1 active:opacity-70 web:hover:bg-accent/40"
      >
        <View className="size-10 rounded-xl bg-background border border-border items-center justify-center overflow-hidden shadow-sm">
          <ConnectorIcon icon={server.icon} size={22} />
        </View>
      </Pressable>
      <Text
        numberOfLines={1}
        className="text-[12px] leading-4 text-muted-foreground text-center mt-1 web:opacity-0 web:group-hover:opacity-100"
      >
        {server.displayName || server.name}
      </Text>
    </View>
  );
}

// A connector is "connected" only when it's genuinely usable: an OAuth
// connector must have completed the flow (server running) — merely having an
// installed McpServer (created before the OAuth redirect) is NOT connected.
// A non-OAuth (stdio) connector is done once installed.
function isServerConnected(server: InstalledMcpServer | undefined): boolean {
  if (!server) return false;
  return server.config?.requiresOAuth ? server.status === "running" : true;
}

function ConnectorRow({
  entry,
  server,
  pending,
  onOpen,
  onConnect,
  onInstall,
}: {
  entry: McpRegistryEntry;
  server: InstalledMcpServer | undefined;
  pending: boolean;
  onOpen: (entry: McpRegistryEntry) => void;
  onConnect: (entry: McpRegistryEntry) => void;
  onInstall: (entry: McpRegistryEntry) => void;
}) {
  const { t } = useTranslation();
  const connected = isServerConnected(server);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={entry.name}
      onPress={() => onOpen(entry)}
      className="flex-row items-center rounded-2xl px-2 py-2 web:hover:bg-accent/40 active:bg-accent/50"
    >
      {/* Icon tile — bordered white square, ref: size-10 rounded-xl border */}
      <View className="size-10 rounded-xl bg-background border border-border items-center justify-center overflow-hidden shrink-0">
        <ConnectorIcon icon={entry.icon} size={20} />
      </View>
      {/* Title + description, ref gap-3.5 / pe-3.5 */}
      <View className="min-w-0 flex-1 ml-3.5 pr-3.5">
        <Text className="text-[14px] leading-[18px] text-foreground" numberOfLines={1}>
          {entry.name}
        </Text>
        <Text className="text-[13px] leading-[18px] text-muted-foreground" numberOfLines={1}>
          {entry.description}
        </Text>
      </View>
      {/* Trailing circular quick-action — its own Pressable so the tap runs
          connect/install instead of opening the detail page. stopPropagation
          keeps the click from bubbling to the row's onPress on web (native's
          nested-responder capture already isolates the inner press). */}
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={
          connected
            ? entry.name
            : entry.requiresOAuth
              ? `${t("connectors.connect")} ${entry.name}`
              : `${t("connectors.install")} ${entry.name}`
        }
        onPress={(e) => {
          e.stopPropagation();
          if (connected) return;
          entry.requiresOAuth ? onConnect(entry) : onInstall(entry);
        }}
        disabled={pending || connected}
        hitSlop={8}
        className="size-8 rounded-full items-center justify-center shrink-0 web:hover:bg-accent active:bg-accent"
      >
        {connected ? (
          <Check size={16} className="text-muted-foreground" />
        ) : pending ? (
          <ActivityIndicator size="small" />
        ) : (
          <Plus size={18} className="text-foreground" />
        )}
      </Pressable>
    </Pressable>
  );
}

function CategorySection({
  title,
  entries,
  installedByRegistry,
  pendingId,
  onOpen,
  onConnect,
  onInstall,
}: {
  title: string;
  entries: McpRegistryEntry[];
  installedByRegistry: Map<string, InstalledMcpServer>;
  pendingId: string | null;
  onOpen: (entry: McpRegistryEntry) => void;
  onConnect: (entry: McpRegistryEntry) => void;
  onInstall: (entry: McpRegistryEntry) => void;
}) {
  return (
    <View className="gap-2">
      <Text className="text-sm font-medium text-foreground">{title}</Text>
      <View className="flex-row flex-wrap md:-mx-1">
        {entries.map((entry) => (
          <View key={entry.id} className="w-full md:w-1/2 md:px-1 mb-4">
            <ConnectorRow
              entry={entry}
              server={installedByRegistry.get(entry.id)}
              pending={pendingId === entry.id}
              onOpen={onOpen}
              onConnect={onConnect}
              onInstall={onInstall}
            />
          </View>
        ))}
      </View>
    </View>
  );
}

export function ConnectorsSection() {
  const { t } = useTranslation();
  const { colors } = useColorScheme();
  const router = useRouter();
  const searchParams = useLocalSearchParams<{
    mcp_oauth_state?: string;
    mcp_oauth_code?: string;
    error?: string;
  }>();

  const {
    registry,
    installed,
    loading,
    install,
    installCustom,
    startOAuth,
    completeOAuth,
  } = useMcpServers();

  const [search, setSearch] = useState("");
  const [tab, setTab] = useState<"public" | "personal">("public");
  const [pendingId, setPendingId] = useState<string | null>(null);

  // Env-var install dialog (for stdio registry entries that need secrets).
  const [installTarget, setInstallTarget] = useState<McpRegistryEntry | null>(null);
  const [envValues, setEnvValues] = useState<Record<string, string>>({});
  const [installing, setInstalling] = useState(false);

  // Custom remote-server dialog.
  const [customDialogOpen, setCustomDialogOpen] = useState(false);
  const [customName, setCustomName] = useState("");
  const [customUrl, setCustomUrl] = useState("");
  const [customHeaderKey, setCustomHeaderKey] = useState("");
  const [customHeaderValue, setCustomHeaderValue] = useState("");
  const [customInstalling, setCustomInstalling] = useState(false);
  const [advancedOpen, setAdvancedOpen] = useState(false);

  // Guards against re-processing the same OAuth callback (keyed on the unique
  // state so sequential connects each finalize exactly once).
  const handledOAuthRef = useRef<string | null>(null);

  useEffect(() => {
    const state = searchParams.mcp_oauth_state;
    const code = searchParams.mcp_oauth_code;
    const error = searchParams.error;

    if (error) {
      if (handledOAuthRef.current === `err:${error}`) return;
      handledOAuthRef.current = `err:${error}`;
      toast.error(t("connectors.oauthError"));
      router.replace("/(app)/settings/connectors");
      return;
    }

    if (state && code) {
      if (handledOAuthRef.current === state) return;
      handledOAuthRef.current = state;
      completeOAuth(state, code)
        .then(() => toast.success(t("connectors.connected")))
        .catch(() => toast.error(t("connectors.connectFailed")))
        .finally(() => router.replace("/(app)/settings/connectors"));
    }
    // eslint order intentionally follows the existing settings screens: react to
    // the callback param values arriving on this screen.
  }, [searchParams.mcp_oauth_state, searchParams.mcp_oauth_code, searchParams.error]);

  const installedByRegistry = useMemo(() => {
    const map = new Map<string, InstalledMcpServer>();
    for (const s of installed) {
      if (s.registryId) map.set(s.registryId, s);
    }
    return map;
  }, [installed]);

  // Only surface genuinely-connected connectors in the Installed grid — an
  // OAuth connector whose flow hasn't completed (installed but not running) is
  // not yet connected.
  const connectedServers = useMemo(
    () => installed.filter((s) => isServerConnected(s)),
    [installed],
  );

  const filteredRegistry = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return registry;
    return registry.filter(
      (e) =>
        e.name.toLowerCase().includes(q) ||
        e.description.toLowerCase().includes(q),
    );
  }, [registry, search]);

  const featured = useMemo(
    () => filteredRegistry.filter((e) => e.featured),
    [filteredRegistry],
  );

  // Personal tab = the user's own custom-added remote connectors.
  const personalServers = useMemo(() => {
    const q = search.trim().toLowerCase();
    const custom = installed.filter((s) => s.source === "custom");
    if (!q) return custom;
    return custom.filter(
      (s) =>
        (s.displayName || s.name).toLowerCase().includes(q) ||
        (s.description || "").toLowerCase().includes(q),
    );
  }, [installed, search]);

  const categorized = useMemo(() => {
    const map = new Map<string, McpRegistryEntry[]>();
    for (const entry of filteredRegistry) {
      if (entry.featured) continue;
      const list = map.get(entry.category) ?? [];
      list.push(entry);
      map.set(entry.category, list);
    }
    const known = (CATEGORY_ORDER as readonly string[]).filter((c) => map.has(c));
    const extras = Array.from(map.keys()).filter(
      (c) => !(CATEGORY_ORDER as readonly string[]).includes(c),
    );
    return [...known, ...extras].map((slug) => ({ slug, entries: map.get(slug) ?? [] }));
  }, [filteredRegistry]);

  const handleOpen = (entry: McpRegistryEntry) =>
    router.push(`/(app)/settings/connectors/${entry.id}`);

  const handleConnect = async (entry: McpRegistryEntry) => {
    setPendingId(entry.id);
    try {
      // Reuse an existing install if the user connected before; otherwise create
      // the McpServer so the backend has a serverId to bind the OAuth state to.
      const existing = installed.find((s) => s.registryId === entry.id);
      const server = existing ?? (await install(entry.id));
      const url = await startOAuth(server._id);
      if (Platform.OS === "web") {
        // Top-level navigation so the provider callback returns to THIS tab with
        // the ?mcp_oauth_state=&mcp_oauth_code= params the screen consumes.
        window.location.href = url;
      } else {
        await Linking.openURL(url);
      }
    } catch (err) {
      console.error("Failed to start connector OAuth:", err);
      toast.error(t("connectors.connectFailed"));
    } finally {
      setPendingId(null);
    }
  };

  const handleInstall = async (entry: McpRegistryEntry) => {
    // Secrets required → collect them in a dialog; otherwise install directly.
    if (entry.requiredEnv.length > 0) {
      setEnvValues({});
      setInstallTarget(entry);
      return;
    }
    setPendingId(entry.id);
    try {
      await install(entry.id);
      toast.success(t("connectors.installedToast", { name: entry.name }));
    } catch {
      toast.error(t("connectors.installFailed"));
    } finally {
      setPendingId(null);
    }
  };

  const handleInstallWithEnv = async () => {
    if (!installTarget) return;
    setInstalling(true);
    try {
      const env = installTarget.requiredEnv.length > 0 ? envValues : undefined;
      await install(installTarget.id, env);
      toast.success(t("connectors.installedToast", { name: installTarget.name }));
      setInstallTarget(null);
      setEnvValues({});
    } catch {
      toast.error(t("connectors.installFailed"));
    } finally {
      setInstalling(false);
    }
  };

  const resetCustomDialog = () => {
    setCustomDialogOpen(false);
    setCustomName("");
    setCustomUrl("");
    setCustomHeaderKey("");
    setCustomHeaderValue("");
    setAdvancedOpen(false);
  };

  const handleInstallCustom = async () => {
    if (!customName.trim() || !customUrl.trim()) return;
    setCustomInstalling(true);
    try {
      const slug = customName
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "");

      const headers: Record<string, string> = {};
      if (customHeaderKey.trim() && customHeaderValue.trim()) {
        headers[customHeaderKey.trim()] = customHeaderValue.trim();
      }

      await installCustom({
        name: slug,
        displayName: customName.trim(),
        transport: "streamable-http",
        config: {
          url: customUrl.trim(),
          ...(Object.keys(headers).length > 0 ? { headers } : {}),
        },
      });

      toast.success(t("connectors.customAdded", { name: customName.trim() }));
      resetCustomDialog();
    } catch (err: unknown) {
      if (errorStatus(err) === 409) {
        toast.error(t("connectors.customExists"));
      } else {
        toast.error(t("connectors.customFailed"));
      }
    } finally {
      setCustomInstalling(false);
    }
  };

  const inputClass =
    "border border-border rounded-lg px-3 py-2 bg-background text-foreground text-sm";

  if (loading) {
    return (
      <View className="flex-1 items-center justify-center py-12">
        <ActivityIndicator size="small" />
      </View>
    );
  }

  return (
    <View className="gap-6">
      {/* Search + Add custom */}
      <View className="flex-row items-center gap-2">
        <View className="flex-1 flex-row items-center gap-2 h-9 rounded-full bg-muted/70 px-3">
          <Search size={15} className="text-muted-foreground" />
          <TextInput
            value={search}
            onChangeText={setSearch}
            placeholder={t("connectors.searchPlaceholder")}
            placeholderTextColor={colors.mutedForeground}
            className="flex-1 text-[13px] text-foreground"
            autoCapitalize="none"
            autoCorrect={false}
          />
        </View>
        <Pressable
          onPress={() => setCustomDialogOpen(true)}
          accessibilityRole="button"
          accessibilityLabel={t("connectors.addCustom")}
          className="h-9 w-9 rounded-full border border-border items-center justify-center active:bg-accent web:hover:bg-accent"
        >
          <Plus size={16} className="text-foreground" />
        </Pressable>
      </View>

      {/* Installed */}
      <View className="gap-3">
        <Text className="text-sm font-medium text-foreground">
          {t("connectors.installed")}
        </Text>
        {connectedServers.length === 0 ? (
          <Text className="text-[13px] text-muted-foreground">
            {t("connectors.installedEmpty")}
          </Text>
        ) : (
          <View className="flex-row flex-wrap gap-3">
            {connectedServers.map((server) => {
              const rid = server.registryId;
              return (
                <InstalledTile
                  key={server._id}
                  server={server}
                  onOpen={
                    rid
                      ? () => router.push(`/(app)/settings/connectors/${rid}`)
                      : undefined
                  }
                />
              );
            })}
          </View>
        )}
      </View>

      {/* Public / Personal tabs — ref: pill tablist */}
      <View className="flex-row items-center gap-1">
        {(["public", "personal"] as const).map((key) => {
          const active = tab === key;
          return (
            <Pressable
              key={key}
              onPress={() => setTab(key)}
              accessibilityRole="tab"
              accessibilityState={{ selected: active }}
              className={cn(
                "h-8 px-4 rounded-full items-center justify-center",
                active ? "bg-muted" : "web:hover:bg-accent/40 active:bg-accent/40",
              )}
            >
              <Text
                className={cn(
                  "text-[13px]",
                  active ? "text-foreground font-medium" : "text-muted-foreground",
                )}
              >
                {t(`connectors.tab.${key}`)}
              </Text>
            </Pressable>
          );
        })}
      </View>

      {tab === "public" ? (
        <>
          {/* Featured */}
          {featured.length > 0 && (
            <CategorySection
              title={t("connectors.category.featured")}
              entries={featured}
              installedByRegistry={installedByRegistry}
              pendingId={pendingId}
              onOpen={handleOpen}
              onConnect={handleConnect}
              onInstall={handleInstall}
            />
          )}

          {/* Category sections */}
          {categorized.map(({ slug, entries }) =>
            entries.length > 0 ? (
              <CategorySection
                key={slug}
                title={t(`connectors.category.${slug}`)}
                entries={entries}
                installedByRegistry={installedByRegistry}
                pendingId={pendingId}
                onOpen={handleOpen}
                onConnect={handleConnect}
                onInstall={handleInstall}
              />
            ) : null,
          )}

          {filteredRegistry.length === 0 && (
            <Text className="text-[13px] text-muted-foreground text-center py-6">
              {t("connectors.noResults")}
            </Text>
          )}
        </>
      ) : (
        <View className="flex-row flex-wrap md:-mx-1">
          {personalServers.length === 0 ? (
            <Text className="text-[13px] text-muted-foreground py-6">
              {t("connectors.personalEmpty")}
            </Text>
          ) : (
            personalServers.map((server) => (
              <View key={server._id} className="w-full md:w-1/2 md:px-1 mb-4">
                <View className="flex-row items-center rounded-2xl px-2 py-2">
                  <View className="size-10 rounded-xl bg-background border border-border items-center justify-center overflow-hidden shrink-0">
                    <ConnectorIcon icon={server.icon} size={20} />
                  </View>
                  <View className="min-w-0 flex-1 ml-3.5 pr-3.5">
                    <Text className="text-[14px] leading-[18px] text-foreground" numberOfLines={1}>
                      {server.displayName || server.name}
                    </Text>
                    <Text className="text-[13px] leading-[18px] text-muted-foreground" numberOfLines={1}>
                      {server.config?.url || server.description || ""}
                    </Text>
                  </View>
                  <View className="size-8 rounded-full items-center justify-center shrink-0">
                    <Check size={16} className="text-muted-foreground" />
                  </View>
                </View>
              </View>
            ))
          )}
        </View>
      )}

      {/* Env-var install dialog */}
      <Dialog open={!!installTarget} onOpenChange={(open) => !open && setInstallTarget(null)}>
        <DialogContent className="max-w-sm">
          <DialogHeader className="gap-1">
            <DialogTitle className="text-lg">
              {t("connectors.installName", { name: installTarget?.name ?? "" })}
            </DialogTitle>
            <DialogDescription className="text-sm">
              {t("connectors.installEnvDescription")}
            </DialogDescription>
          </DialogHeader>
          <View className="gap-3">
            {installTarget?.requiredEnv.map((envKey) => (
              <View key={envKey} className="gap-1">
                <Text className="text-xs font-medium text-muted-foreground">{envKey}</Text>
                <TextInput
                  className={inputClass}
                  placeholder={t("connectors.enterValue", { name: envKey })}
                  placeholderTextColor={colors.mutedForeground}
                  value={envValues[envKey] || ""}
                  onChangeText={(val) => setEnvValues((prev) => ({ ...prev, [envKey]: val }))}
                  secureTextEntry={
                    envKey.toLowerCase().includes("secret") ||
                    envKey.toLowerCase().includes("key")
                  }
                />
              </View>
            ))}
          </View>
          <DialogFooter className="gap-2 mt-2">
            <Button
              variant="outline"
              size="sm"
              className="flex-1 h-9"
              onPress={() => setInstallTarget(null)}
              disabled={installing}
            >
              <Text className="text-sm">{t("common.cancel")}</Text>
            </Button>
            <Button
              size="sm"
              className="flex-1 h-9"
              onPress={handleInstallWithEnv}
              disabled={installing}
            >
              <Text className="text-sm">
                {installing ? t("connectors.installing") : t("connectors.install")}
              </Text>
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Custom remote-server dialog */}
      <Dialog open={customDialogOpen} onOpenChange={(open) => !open && resetCustomDialog()}>
        <DialogContent className="max-w-sm">
          <DialogHeader className="gap-1">
            <DialogTitle className="text-lg">{t("connectors.addCustomTitle")}</DialogTitle>
            <DialogDescription className="text-sm">
              {t("connectors.addCustomDescription")}
            </DialogDescription>
          </DialogHeader>

          <View className="gap-3">
            <View className="gap-1">
              <Text className="text-xs font-medium text-muted-foreground">
                {t("connectors.nameLabel")}
              </Text>
              <TextInput
                className={inputClass}
                placeholder={t("connectors.namePlaceholder")}
                placeholderTextColor={colors.mutedForeground}
                value={customName}
                onChangeText={setCustomName}
                autoCapitalize="words"
              />
            </View>

            <View className="gap-1">
              <Text className="text-xs font-medium text-muted-foreground">
                {t("connectors.urlLabel")}
              </Text>
              <TextInput
                className={inputClass}
                placeholder="https://example.com/mcp"
                placeholderTextColor={colors.mutedForeground}
                value={customUrl}
                onChangeText={setCustomUrl}
                autoCapitalize="none"
                autoCorrect={false}
                keyboardType="url"
              />
            </View>

            <Collapsible open={advancedOpen} onOpenChange={setAdvancedOpen}>
              <CollapsibleTrigger asChild>
                <Pressable className="flex-row items-center gap-1 py-1">
                  <ChevronDown
                    size={14}
                    className="text-muted-foreground"
                    style={advancedOpen ? undefined : { transform: [{ rotate: "-90deg" }] }}
                  />
                  <Text className="text-xs font-medium text-muted-foreground">
                    {t("connectors.advancedSettings")}
                  </Text>
                </Pressable>
              </CollapsibleTrigger>
              <CollapsibleContent>
                <View className="gap-3 mt-2">
                  <View className="gap-1">
                    <Text className="text-xs font-medium text-muted-foreground">
                      {t("connectors.headerNameLabel")}
                    </Text>
                    <TextInput
                      className={inputClass}
                      placeholder="Authorization"
                      placeholderTextColor={colors.mutedForeground}
                      value={customHeaderKey}
                      onChangeText={setCustomHeaderKey}
                      autoCapitalize="none"
                      autoCorrect={false}
                    />
                  </View>
                  <View className="gap-1">
                    <Text className="text-xs font-medium text-muted-foreground">
                      {t("connectors.headerValueLabel")}
                    </Text>
                    <TextInput
                      className={inputClass}
                      placeholder="Bearer sk-..."
                      placeholderTextColor={colors.mutedForeground}
                      value={customHeaderValue}
                      onChangeText={setCustomHeaderValue}
                      autoCapitalize="none"
                      autoCorrect={false}
                      secureTextEntry
                    />
                  </View>
                </View>
              </CollapsibleContent>
            </Collapsible>
          </View>

          <DialogFooter className="gap-2 mt-2">
            <Button
              variant="outline"
              size="sm"
              className="flex-1 h-9"
              onPress={resetCustomDialog}
              disabled={customInstalling}
            >
              <Text className="text-sm">{t("common.cancel")}</Text>
            </Button>
            <Button
              size="sm"
              className="flex-1 h-9"
              onPress={handleInstallCustom}
              disabled={customInstalling || !customName.trim() || !customUrl.trim()}
            >
              <Text className="text-sm">
                {customInstalling ? t("connectors.adding") : t("connectors.add")}
              </Text>
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </View>
  );
}
