import { errorStatus } from '@/lib/errors/error-utils';
import {
  useMcpServers,
  type InstalledMcpServer,
  type McpRegistryEntry,
} from '@/lib/hooks/use-mcp-servers';
import { useTranslation } from '@/lib/hooks/use-translation';
import { Button } from '@oxy.so/bloom/button';
import { Dialog } from '@oxy.so/bloom/dialog';
import { RiCheckLine } from '@oxy.so/bloom/icons/RiCheckLine';
import { Search } from '@oxy.so/bloom/search';
import {
  SettingsCard,
  SettingsRow,
  SettingsSection,
  SettingsServerList,
  type SettingsMcpServer,
  type SettingsMenuAction,
  type SettingsServerTone,
} from '@oxy.so/bloom/settings-modal';
import * as Skeleton from '@oxy.so/bloom/skeleton';
import { confirm } from '@oxy.so/bloom/surfaces';
import { TextFieldInput, TextFieldLabel } from '@oxy.so/bloom/text-field';
import { toast } from '@oxy.so/bloom/toast';
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from '@oxy.so/bloom/accordion';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Linking, Platform, View } from 'react-native';
import { SettingsPreferenceSelect } from './preference-select';
import { useAliaSettings } from './settings-context';

type Translate = ReturnType<typeof useTranslation>['t'];

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

// Letter-tile swatches for the server list, picked by name so a connector keeps
// its colour across renders.
const TILE_TONES: SettingsServerTone[] = [
  'secondary',
  'primary',
  'warning',
  'info',
  'success',
  'tertiary',
  'inverse',
  'neutral',
];

function toneFor(name: string): SettingsServerTone {
  let hash = 0;
  for (let i = 0; i < name.length; i++) {
    hash = (hash * 31 + name.charCodeAt(i)) | 0;
  }
  return TILE_TONES[Math.abs(hash) % TILE_TONES.length] ?? 'neutral';
}

// A connector is "connected" only when it's genuinely usable: an OAuth
// connector must have completed the flow (server running) — merely having an
// installed McpServer (created before the OAuth redirect) is NOT connected.
// A non-OAuth (stdio) connector is done once installed.
function isServerConnected(server: InstalledMcpServer | undefined): boolean {
  if (!server) return false;
  return server.config?.requiresOAuth ? server.status === 'running' : true;
}

/** "Stopped · 3 tools enabled" — the status only when it is not the usual one. */
function serverSummary(
  server: InstalledMcpServer,
  t: Translate,
  withUrl = false,
): string {
  const parts: string[] = [];
  if (withUrl && server.config?.url) parts.push(server.config.url);
  if (server.status !== 'running' && server.status !== 'error') {
    parts.push(t(`settings.connections.serverStatus.${server.status}`));
  }
  parts.push(
    t('settings.connections.toolCount', {
      count: (server.tools ?? []).length,
    }),
  );
  return parts.join(' · ');
}

function toSettingsServer(
  server: InstalledMcpServer,
  t: Translate,
  withUrl = false,
): SettingsMcpServer {
  const name = server.displayName || server.name;
  return {
    id: server._id,
    name,
    tone: toneFor(name),
    status: server.status === 'error' ? 'error' : 'connected',
    summary: serverSummary(server, t, withUrl),
    tools: (server.tools ?? []).map((tool) => tool.name),
  };
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
      <>
        <Button
          size="sm"
          appearance="outline"
          tone="neutral"
          onPress={() => onOpen(entry)}
        >
          {t('settings.connections.viewDetails')}
        </Button>
        {connected ? (
          <Button
            size="sm"
            appearance="outline"
            tone="neutral"
            leadingIcon={RiCheckLine}
            disabled
          >
            {t('connectors.connected')}
          </Button>
        ) : (
          <Button
            size="sm"
            appearance="outline"
            tone="neutral"
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
      </>
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
    <SettingsSection label={title} inset={8}>
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
  const settings = useAliaSettings();
  const searchParams = settings.params;

  const {
    registry,
    installed,
    loading,
    install,
    installCustom,
    uninstall,
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
  /** The custom connector's advanced settings (its auth header), folded away until asked for. */
  const [advanced, setAdvanced] = useState<string | undefined>(undefined);

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

  // Only surface genuinely-connected connectors in the Installed list — an
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

  const serverActions: SettingsMenuAction[] = [
    { id: 'details', label: t('settings.connections.viewDetails') },
    { id: 'uninstall', label: t('connectors.uninstall') },
  ];

  const handleOpen = (entry: McpRegistryEntry) =>
    settings.open('connector-detail', { id: entry.id });

  const openServerDetails = (server: InstalledMcpServer) => {
    if (server.registryId) {
      settings.open('connector-detail', { id: server.registryId });
    } else {
      // Custom connectors have no catalog page; their home is the Personal list.
      setTab('personal');
    }
  };

  const handleUninstallServer = async (server: InstalledMcpServer) => {
    const name = server.displayName || server.name;
    const ok = await confirm({
      title: t('connectors.uninstallTitle'),
      description: t('connectors.uninstallDescription', { name }),
      confirmLabel: t('connectors.uninstall'),
      cancelLabel: t('common.cancel'),
      destructive: true,
    });
    if (!ok) return;
    try {
      await uninstall(server._id);
      toast.success(t('connectors.uninstalledToast', { name }));
    } catch {
      toast.error(t('connectors.uninstallFailed'));
    }
  };

  const findServer = (serverId: string) =>
    installed.find((s) => s._id === serverId);

  const handleServerAction = (serverId: string, actionId: string) => {
    const server = findServer(serverId);
    if (!server) return;
    if (actionId === 'details') openServerDetails(server);
    if (actionId === 'uninstall') void handleUninstallServer(server);
  };

  const handleServerLogout = (serverId: string) => {
    const server = findServer(serverId);
    if (server) void handleUninstallServer(server);
  };

  const handleShowOutput = (serverId: string) => {
    const server = findServer(serverId);
    if (!server) return;
    if (server.statusMessage) {
      toast.error(
        `${server.displayName || server.name}: ${server.statusMessage}`,
      );
    } else if (server.registryId) {
      openServerDetails(server);
    } else {
      toast.error(t('settings.connections.noOutput'));
    }
  };

  const serverListProps = {
    actions: serverActions,
    onServerAction: handleServerAction,
    onLogout: handleServerLogout,
    onShowOutput: handleShowOutput,
    onAddServer: () => setCustomDialogOpen(true),
    addServerLabel: t('connectors.addCustomTitle'),
    addServerDescription: t('connectors.addCustomDescription'),
  };

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
    setAdvanced(undefined);
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

  if (loading) {
    return (
      <View className="w-full gap-6">
        <SettingsSection label={t('connectors.installed')} inset={8}>
          <SettingsCard>
            <SettingsRow label={t('common.loading')}>
              <Skeleton.Box width={202} height={32} borderRadius={10} />
            </SettingsRow>
          </SettingsCard>
        </SettingsSection>
      </View>
    );
  }

  return (
    <View className="w-full gap-6">
      <SettingsSection
        label={t('connectors.installed')}
        description={
          connectedServers.length ? undefined : t('connectors.installedEmpty')
        }
        inset={8}
      >
        <SettingsServerList
          servers={connectedServers.map((server) =>
            toSettingsServer(server, t),
          )}
          {...serverListProps}
        />
      </SettingsSection>

      <SettingsSection
        label={t('connectors.title')}
        description={t('connectors.subtitle')}
        inset={8}
        action={
          <SettingsPreferenceSelect
            label={t('settings.connections.catalog')}
            value={tab}
            onChange={setTab}
            items={[
              { value: 'public', label: t('connectors.tab.public') },
              { value: 'personal', label: t('connectors.tab.personal') },
            ]}
          />
        }
      >
        <Search
          label={t('connectors.searchPlaceholder')}
          value={search}
          onChangeText={setSearch}
          onClearText={() => setSearch('')}
        />
      </SettingsSection>

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
            <SettingsCard>
              <SettingsRow label={t('connectors.noResults')} />
            </SettingsCard>
          )}
        </>
      ) : (
        <SettingsSection
          label={t('connectors.tab.personal')}
          description={
            personalServers.length ? undefined : t('connectors.personalEmpty')
          }
          inset={8}
        >
          <SettingsServerList
            servers={personalServers.map((server) =>
              toSettingsServer(server, t, true),
            )}
            {...serverListProps}
          />
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
            <View key={envKey}>
              <TextFieldLabel>{envKey}</TextFieldLabel>
              <TextFieldInput
                label={t('connectors.enterValue', { name: envKey })}
                placeholder={t('connectors.enterValue', { name: envKey })}
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
          <View>
            <TextFieldLabel>{t('connectors.nameLabel')}</TextFieldLabel>
            <TextFieldInput
              label={t('connectors.namePlaceholder')}
              placeholder={t('connectors.namePlaceholder')}
              value={customName}
              onChangeText={setCustomName}
              autoCapitalize="words"
            />
          </View>

          <View>
            <TextFieldLabel>{t('connectors.urlLabel')}</TextFieldLabel>
            <TextFieldInput
              label="https://example.com/mcp"
              placeholder="https://example.com/mcp"
              value={customUrl}
              onChangeText={setCustomUrl}
              autoCapitalize="none"
              autoCorrect={false}
              keyboardType="url"
            />
          </View>

          <Accordion
            type="single"
            value={advanced}
            onValueChange={(next) => setAdvanced(typeof next === 'string' ? next : undefined)}
          >
            <AccordionItem value="advanced">
              <AccordionTrigger>{t('connectors.advancedSettings')}</AccordionTrigger>
              <AccordionContent>
              <View className="gap-3">
                <View>
                  <TextFieldLabel>
                    {t('connectors.headerNameLabel')}
                  </TextFieldLabel>
                  <TextFieldInput
                    label="Authorization"
                    placeholder="Authorization"
                    value={customHeaderKey}
                    onChangeText={setCustomHeaderKey}
                    autoCapitalize="none"
                    autoCorrect={false}
                  />
                </View>
                <View>
                  <TextFieldLabel>
                    {t('connectors.headerValueLabel')}
                  </TextFieldLabel>
                  <TextFieldInput
                    label="Bearer sk-..."
                    placeholder="Bearer sk-..."
                    value={customHeaderValue}
                    onChangeText={setCustomHeaderValue}
                    autoCapitalize="none"
                    autoCorrect={false}
                    secureTextEntry
                  />
                </View>
              </View>
              </AccordionContent>
            </AccordionItem>
          </Accordion>
        </View>
      </Dialog>
    </View>
  );
}
