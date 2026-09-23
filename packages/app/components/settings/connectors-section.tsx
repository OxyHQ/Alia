import { ActionKeyIcon } from '@/components/ui/action-key-icon';
import { errorStatus } from '@/lib/errors/error-utils';
import {
  useMcpServers,
  type InstalledMcpServer,
  type McpRegistryEntry,
} from '@/lib/hooks/use-mcp-servers';
import { useTranslation } from '@/lib/hooks/use-translation';
import { useColorScheme } from '@/lib/useColorScheme';
import { Button } from '@oxy.so/bloom/button';
import { Dialog } from '@oxy.so/bloom/dialog';
import { Search } from '@oxy.so/bloom/search';
import {
  SettingsCard,
  SettingsRow,
  SettingsSection,
  SettingsValueField,
} from '@oxy.so/bloom/settings-modal';
import { TextFieldInput } from '@oxy.so/bloom/text-field';
import { toast } from '@oxy.so/bloom/toast';
import { Text } from '@oxy.so/bloom/typography';
import * as Collapsible from '@rn-primitives/collapsible';
import { Image } from 'expo-image';
import { useRouter } from 'expo-router';
import { ChevronDown, Plus } from 'lucide-react-native';
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Linking,
  Platform,
  Pressable,
  View,
} from 'react-native';
import { SettingsPreferenceSelect } from './preference-select';
import { useAliaSettings } from './settings-context';

// Ordered registry categories rendered after the Featured section. A featured
// entry appears ONLY in Featured, never duplicated into its category section.
const CATEGORY_ORDER = [
  'productivity',
  'development',
  'communication',
  'data',
  'search',
  'filesystem',
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
  return <ActionKeyIcon size={size} />;
}

// A connector is "connected" only when it's genuinely usable: an OAuth
// connector must have completed the flow (server running) — merely having an
// installed McpServer (created before the OAuth redirect) is NOT connected.
// A non-OAuth (stdio) connector is done once installed.
function isServerConnected(server: InstalledMcpServer | undefined): boolean {
  if (!server) return false;
  return server.config?.requiresOAuth ? server.status === 'running' : true;
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
    <SettingsRow label={entry.name} description={entry.description}>
      <View className="flex-row flex-wrap gap-2">
        <Button variant="secondary" size="sm" onPress={() => onOpen(entry)}>
          {t('connectors.detailTitle')}
        </Button>
        {!connected && (
          <Button
            variant="secondary"
            size="sm"
            loading={pending}
            onPress={() =>
              entry.requiresOAuth ? onConnect(entry) : onInstall(entry)
            }
          >
            {entry.requiresOAuth
              ? t('connectors.connect')
              : t('connectors.install')}
          </Button>
        )}
        {connected && (
          <SettingsValueField>{t('connectors.connected')}</SettingsValueField>
        )}
      </View>
    </SettingsRow>
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
    <SettingsSection label={title}>
      <SettingsCard>
        {entries.map((entry) => (
          <ConnectorRow
            key={entry.id}
            entry={entry}
            server={installedByRegistry.get(entry.id)}
            pending={pendingId === entry.id}
            onOpen={onOpen}
            onConnect={onConnect}
            onInstall={onInstall}
          />
        ))}
      </SettingsCard>
    </SettingsSection>
  );
}

export function ConnectorsSection() {
  const { t } = useTranslation();
  const { colors } = useColorScheme();
  const router = useRouter();
  const settings = useAliaSettings();
  const searchParams = settings.params;

  const {
    registry,
    installed,
    loading,
    install,
    installCustom,
    startOAuth,
    completeOAuth,
  } = useMcpServers();

  const [search, setSearch] = useState('');
  const [tab, setTab] = useState<'public' | 'personal'>('public');
  const [pendingId, setPendingId] = useState<string | null>(null);

  // Env-var install dialog (for stdio registry entries that need secrets).
  const [installTarget, setInstallTarget] = useState<McpRegistryEntry | null>(
    null,
  );
  const [envValues, setEnvValues] = useState<Record<string, string>>({});
  const [installing, setInstalling] = useState(false);

  // Custom remote-server dialog.
  const [customDialogOpen, setCustomDialogOpen] = useState(false);
  const [customName, setCustomName] = useState('');
  const [customUrl, setCustomUrl] = useState('');
  const [customHeaderKey, setCustomHeaderKey] = useState('');
  const [customHeaderValue, setCustomHeaderValue] = useState('');
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
      toast.error(t('connectors.oauthError'));
      settings.open('connectors');
      return;
    }

    if (state && code) {
      if (handledOAuthRef.current === state) return;
      handledOAuthRef.current = state;
      completeOAuth(state, code)
        .then(() => toast.success(t('connectors.connected')))
        .catch(() => toast.error(t('connectors.connectFailed')))
        .finally(() => settings.open('connectors'));
    }
    // eslint order intentionally follows the existing settings screens: react to
    // the callback param values arriving on this screen.
  }, [
    searchParams.mcp_oauth_state,
    searchParams.mcp_oauth_code,
    searchParams.error,
  ]);

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
    const custom = installed.filter((s) => s.source === 'custom');
    if (!q) return custom;
    return custom.filter(
      (s) =>
        (s.displayName || s.name).toLowerCase().includes(q) ||
        (s.description || '').toLowerCase().includes(q),
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
    const known = (CATEGORY_ORDER as readonly string[]).filter((c) =>
      map.has(c),
    );
    const extras = Array.from(map.keys()).filter(
      (c) => !(CATEGORY_ORDER as readonly string[]).includes(c),
    );
    return [...known, ...extras].map((slug) => ({
      slug,
      entries: map.get(slug) ?? [],
    }));
  }, [filteredRegistry]);

  const handleOpen = (entry: McpRegistryEntry) =>
    settings.open('connector-detail', { id: entry.id });

  const handleConnect = async (entry: McpRegistryEntry) => {
    setPendingId(entry.id);
    try {
      // Reuse an existing install if the user connected before; otherwise create
      // the McpServer so the backend has a serverId to bind the OAuth state to.
      const existing = installed.find((s) => s.registryId === entry.id);
      const server = existing ?? (await install(entry.id));
      const url = await startOAuth(server._id);
      if (Platform.OS === 'web') {
        // Top-level navigation so the provider callback returns to THIS tab with
        // the ?mcp_oauth_state=&mcp_oauth_code= params the screen consumes.
        window.location.href = url;
      } else {
        await Linking.openURL(url);
      }
    } catch (err) {
      console.error('Failed to start connector OAuth:', err);
      toast.error(t('connectors.connectFailed'));
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
      toast.success(t('connectors.installedToast', { name: entry.name }));
    } catch {
      toast.error(t('connectors.installFailed'));
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
      toast.success(
        t('connectors.installedToast', { name: installTarget.name }),
      );
      setInstallTarget(null);
      setEnvValues({});
    } catch {
      toast.error(t('connectors.installFailed'));
    } finally {
      setInstalling(false);
    }
  };

  const resetCustomDialog = () => {
    setCustomDialogOpen(false);
    setCustomName('');
    setCustomUrl('');
    setCustomHeaderKey('');
    setCustomHeaderValue('');
    setAdvancedOpen(false);
  };

  const handleInstallCustom = async () => {
    if (!customName.trim() || !customUrl.trim()) return;
    setCustomInstalling(true);
    try {
      const slug = customName
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '');

      const headers: Record<string, string> = {};
      if (customHeaderKey.trim() && customHeaderValue.trim()) {
        headers[customHeaderKey.trim()] = customHeaderValue.trim();
      }

      await installCustom({
        name: slug,
        displayName: customName.trim(),
        transport: 'streamable-http',
        config: {
          url: customUrl.trim(),
          ...(Object.keys(headers).length > 0 ? { headers } : {}),
        },
      });

      toast.success(t('connectors.customAdded', { name: customName.trim() }));
      resetCustomDialog();
    } catch (err: unknown) {
      if (errorStatus(err) === 409) {
        toast.error(t('connectors.customExists'));
      } else {
        toast.error(t('connectors.customFailed'));
      }
    } finally {
      setCustomInstalling(false);
    }
  };

  const inputClass =
    'border border-border rounded-lg px-3 py-2 bg-background text-foreground text-sm';

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
        <View className="flex-1">
          <Search
            label={t('connectors.searchPlaceholder')}
            value={search}
            onChangeText={setSearch}
            onClearText={() => setSearch('')}
          />
        </View>
        <Pressable
          onPress={() => setCustomDialogOpen(true)}
          accessibilityRole="button"
          accessibilityLabel={t('connectors.addCustom')}
          className="h-11 w-11 rounded-full border border-border items-center justify-center active:bg-accent web:hover:bg-accent"
        >
          <Plus size={16} className="text-foreground" />
        </Pressable>
      </View>

      <SettingsSection label={t('connectors.installed')}>
        <SettingsCard>
          {connectedServers.length ? (
            connectedServers.map((server) => (
              <SettingsRow
                key={server._id}
                label={server.displayName || server.name}
                description={server.description}
              >
                {server.registryId ? (
                  <Button
                    size="sm"
                    variant="secondary"
                    onPress={() =>
                      settings.open('connector-detail', {
                        id: server.registryId!,
                      })
                    }
                  >
                    {t('connectors.detailTitle')}
                  </Button>
                ) : (
                  <SettingsValueField>{server.status}</SettingsValueField>
                )}
              </SettingsRow>
            ))
          ) : (
            <SettingsRow label={t('connectors.installedEmpty')} />
          )}
        </SettingsCard>
      </SettingsSection>
      <SettingsPreferenceSelect
        label="Connector catalog"
        value={tab}
        onChange={setTab}
        items={[
          { value: 'public', label: t('connectors.tab.public') },
          { value: 'personal', label: t('connectors.tab.personal') },
        ]}
      />

      {tab === 'public' ? (
        <>
          {/* Featured */}
          {featured.length > 0 && (
            <CategorySection
              title={t('connectors.category.featured')}
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
              {t('connectors.noResults')}
            </Text>
          )}
        </>
      ) : (
        <SettingsSection label={t('connectors.tab.personal')}>
          <SettingsCard>
            {personalServers.length ? (
              personalServers.map((server) => (
                <SettingsRow
                  key={server._id}
                  label={server.displayName || server.name}
                  description={server.config?.url || server.description || ''}
                >
                  <SettingsValueField>{server.status}</SettingsValueField>
                </SettingsRow>
              ))
            ) : (
              <SettingsRow label={t('connectors.personalEmpty')} />
            )}
          </SettingsCard>
        </SettingsSection>
      )}

      {/* Env-var install dialog */}
      <Dialog
        open={!!installTarget}
        onClose={() => setInstallTarget(null)}
        placement={{ base: 'bottom', md: 'center' }}
        maxWidth={384}
        title={t('connectors.installName', { name: installTarget?.name ?? '' })}
        description={t('connectors.installEnvDescription')}
        actions={[
          { label: t('common.cancel'), color: 'cancel', disabled: installing },
          {
            label: installing
              ? t('connectors.installing')
              : t('connectors.install'),
            onPress: handleInstallWithEnv,
            disabled: installing,
            // The install is in flight when this runs and the label reports it.
            shouldCloseOnPress: false,
          },
        ]}
      >
        <View className="gap-3">
          {installTarget?.requiredEnv.map((envKey) => (
            <View key={envKey} className="gap-1">
              <Text className="text-xs font-medium text-muted-foreground">
                {envKey}
              </Text>
              <TextFieldInput
                label={t('connectors.enterValue', { name: envKey })}

                placeholder={t('connectors.enterValue', { name: envKey })}
                placeholderTextColor={colors.mutedForeground}
                value={envValues[envKey] || ''}
                onChangeText={(val) =>
                  setEnvValues((prev) => ({ ...prev, [envKey]: val }))
                }
                secureTextEntry={
                  envKey.toLowerCase().includes('secret') ||
                  envKey.toLowerCase().includes('key')
                }
              />
            </View>
          ))}
        </View>
      </Dialog>

      {/* Custom remote-server dialog */}
      <Dialog
        open={customDialogOpen}
        onClose={resetCustomDialog}
        placement={{ base: 'bottom', md: 'center' }}
        maxWidth={384}
        title={t('connectors.addCustomTitle')}
        description={t('connectors.addCustomDescription')}
        actions={[
          {
            label: t('common.cancel'),
            color: 'cancel',
            disabled: customInstalling,
          },
          {
            label: customInstalling
              ? t('connectors.adding')
              : t('connectors.add'),
            onPress: handleInstallCustom,
            disabled:
              customInstalling || !customName.trim() || !customUrl.trim(),
            // The install is in flight when this runs and the label reports it.
            shouldCloseOnPress: false,
          },
        ]}
      >
        <View className="gap-3">
          <View className="gap-1">
            <Text className="text-xs font-medium text-muted-foreground">
              {t('connectors.nameLabel')}
            </Text>
            <TextFieldInput
              label={t('connectors.namePlaceholder')}

              placeholder={t('connectors.namePlaceholder')}
              placeholderTextColor={colors.mutedForeground}
              value={customName}
              onChangeText={setCustomName}
              autoCapitalize="words"
            />
          </View>

          <View className="gap-1">
            <Text className="text-xs font-medium text-muted-foreground">
              {t('connectors.urlLabel')}
            </Text>
            <TextFieldInput
              label="https://example.com/mcp"

              placeholder="https://example.com/mcp"
              placeholderTextColor={colors.mutedForeground}
              value={customUrl}
              onChangeText={setCustomUrl}
              autoCapitalize="none"
              autoCorrect={false}
              keyboardType="url"
            />
          </View>

          <Collapsible.Root open={advancedOpen} onOpenChange={setAdvancedOpen}>
            <Collapsible.Trigger asChild>
              <Pressable className="flex-row items-center gap-1 py-1">
                <ChevronDown
                  size={14}
                  className="text-muted-foreground"
                  style={
                    advancedOpen
                      ? undefined
                      : { transform: [{ rotate: '-90deg' }] }
                  }
                />
                <Text className="text-xs font-medium text-muted-foreground">
                  {t('connectors.advancedSettings')}
                </Text>
              </Pressable>
            </Collapsible.Trigger>
            <Collapsible.Content>
              <View className="gap-3 mt-2">
                <View className="gap-1">
                  <Text className="text-xs font-medium text-muted-foreground">
                    {t('connectors.headerNameLabel')}
                  </Text>
                  <TextFieldInput
                    label="Authorization"

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
                    {t('connectors.headerValueLabel')}
                  </Text>
                  <TextFieldInput
                    label="Bearer sk-..."

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
            </Collapsible.Content>
          </Collapsible.Root>
        </View>
      </Dialog>
    </View>
  );
}
