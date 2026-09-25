import { useMcpServers } from '@/features/connections/runtime/use-mcp-servers';
import { useTranslation } from '@/shared/i18n/use-translation';
import { Button } from '@oxy.so/bloom/button';
import { Dialog } from '@oxy.so/bloom/dialog';
import { RiArrowLeftLine } from '@oxy.so/bloom/icons/RiArrowLeftLine';
import { RiDeleteBinLine } from '@oxy.so/bloom/icons/RiDeleteBinLine';
import { RiExternalLinkLine } from '@oxy.so/bloom/icons/RiExternalLinkLine';
import {
  SettingsCard,
  SettingsProfilePage,
  SettingsRow,
  SettingsValueField,
} from '@oxy.so/bloom/settings-modal';
import * as Skeleton from '@oxy.so/bloom/skeleton';
import { confirm } from '@oxy.so/bloom/surfaces';
import { TextFieldInput, TextFieldLabel } from '@oxy.so/bloom/text-field';
import { toast } from '@oxy.so/bloom/toast';
import { useState } from 'react';
import { Linking, Platform, View } from 'react-native';
import { useAliaSettings } from './settings-context';

// A tool name implies write access when it reads as a mutation verb.
const WRITE_VERB = /create|write|update|delete|send|post|add|remove|edit|set/i;

export function ConnectorDetailSection() {
  const settings = useAliaSettings();
  const { id } = settings.params;
  const { t } = useTranslation();

  const { registry, installed, loading, install, uninstall, startOAuth } =
    useMcpServers();

  const [pending, setPending] = useState(false);
  const [envDialogOpen, setEnvDialogOpen] = useState(false);
  const [envValues, setEnvValues] = useState<Record<string, string>>({});

  const entry = registry.find((e) => e.id === id);
  const server = installed.find((s) => s.registryId === id);

  const goBack = () => settings.open('connectors');

  const handleConnect = async () => {
    if (!entry) return;
    setPending(true);
    try {
      // Reuse an existing install if the user connected before; otherwise create
      // the McpServer so the backend has a serverId to bind the OAuth state to.
      const existing = installed.find((s) => s.registryId === entry.id);
      const srv = existing ?? (await install(entry.id));
      const url = await startOAuth(srv._id);
      if (Platform.OS === 'web') {
        // Top-level navigation so the provider callback returns with the
        // ?mcp_oauth_state=&mcp_oauth_code= params the catalog screen consumes.
        window.location.href = url;
      } else {
        await Linking.openURL(url);
      }
    } catch (err) {
      console.error('Failed to start connector OAuth:', err);
      toast.error(t('connectors.connectFailed'));
    } finally {
      setPending(false);
    }
  };

  const handleInstall = async () => {
    if (!entry) return;
    if (entry.requiredEnv.length > 0) {
      setEnvValues({});
      setEnvDialogOpen(true);
      return;
    }
    setPending(true);
    try {
      await install(entry.id);
      toast.success(t('connectors.installedToast', { name: entry.name }));
    } catch {
      toast.error(t('connectors.installFailed'));
    } finally {
      setPending(false);
    }
  };

  const handleInstallWithEnv = async () => {
    if (!entry) return;
    setPending(true);
    try {
      await install(entry.id, envValues);
      toast.success(t('connectors.installedToast', { name: entry.name }));
      setEnvDialogOpen(false);
      setEnvValues({});
    } catch {
      toast.error(t('connectors.installFailed'));
    } finally {
      setPending(false);
    }
  };

  const handleUninstall = async () => {
    if (!server || !entry) return;
    const ok = await confirm({
      title: t('connectors.uninstallTitle'),
      description: t('connectors.uninstallDescription', { name: entry.name }),
      confirmLabel: t('connectors.uninstall'),
      cancelLabel: t('common.cancel'),
      destructive: true,
    });
    if (!ok) return;
    setPending(true);
    try {
      await uninstall(server._id);
      toast.success(t('connectors.uninstalledToast', { name: entry.name }));
    } catch {
      toast.error(t('connectors.uninstallFailed'));
    } finally {
      setPending(false);
    }
  };

  if (loading)
    return (
      <SettingsCard>
        <SettingsRow label={t('common.loading')}>
          <Skeleton.Box width={202} height={32} borderRadius={10} />
        </SettingsRow>
      </SettingsCard>
    );
  if (!entry)
    return (
      <SettingsProfilePage
        sections={[
          {
            key: 'missing',
            rows: [
              {
                key: 'missing',
                label: t('connectors.notFound'),
                control: (
                  <Button
                    size="sm"
                    appearance="outline"
                    tone="neutral"
                    leadingIcon={RiArrowLeftLine}
                    onPress={goBack}
                  >
                    {t('connectors.back')}
                  </Button>
                ),
              },
            ],
          },
        ]}
      />
    );

  const requiresOAuth = !!entry.requiresOAuth;
  const needsEnv = entry.requiredEnv.length > 0;
  // "Connected" requires the OAuth flow to have completed (server running) —
  // an installed-but-not-yet-authorized OAuth connector is NOT connected. A
  // non-OAuth (stdio) connector is done once installed.
  const connected =
    !!server && (requiresOAuth ? server.status === 'running' : true);
  const tools = server?.tools ?? [];
  const hasWriteTool = tools.some((tl) => WRITE_VERB.test(tl.name));
  const capabilities = hasWriteTool
    ? t('settings.connections.capability.readWrite')
    : t('settings.connections.capability.read');
  const authValue = requiresOAuth
    ? t('settings.connections.auth.oauth')
    : needsEnv
      ? t('settings.connections.auth.apiKey')
      : t('settings.connections.auth.none');
  const statusValue = connected
    ? t('connectors.connected')
    : server
      ? t(`settings.connections.serverStatus.${server.status}`)
      : t('settings.connections.notConnected');

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
    <>
      <SettingsProfilePage
        sections={[
          {
            key: 'connector',
            rows: [
              {
                key: 'back',
                label: t('connectors.detailTitle'),
                control: (
                  <Button
                    size="sm"
                    appearance="outline"
                    tone="neutral"
                    leadingIcon={RiArrowLeftLine}
                    onPress={goBack}
                  >
                    {t('connectors.back')}
                  </Button>
                ),
              },
              {
                key: 'identity',
                label: entry.name,
                description: entry.description,
                control: (
                  <>
                    {!connected && (
                      <Button
                        size="sm"
                        appearance="outline"
                        tone="neutral"
                        onPress={requiresOAuth ? handleConnect : handleInstall}
                        disabled={pending}
                      >
                        {requiresOAuth
                          ? t('connectors.connect')
                          : t('connectors.install')}
                      </Button>
                    )}
                    {server && (
                      <Button
                        size="sm"
                        appearance="outline"
                        tone="neutral"
                        leadingIcon={RiDeleteBinLine}
                        onPress={handleUninstall}
                        disabled={pending}
                      >
                        {t('connectors.uninstall')}
                      </Button>
                    )}
                  </>
                ),
              },
            ],
          },
          {
            key: 'information',
            label: t('connectors.information'),
            rows: [
              {
                key: 'status',
                label: t('connectors.status'),
                control: <SettingsValueField>{statusValue}</SettingsValueField>,
              },
              {
                key: 'capabilities',
                label: t('connectors.capabilities'),
                control: (
                  <SettingsValueField>{capabilities}</SettingsValueField>
                ),
              },
              {
                key: 'auth',
                label: t('connectors.authentication'),
                control: <SettingsValueField>{authValue}</SettingsValueField>,
              },
              ...(websiteUrl
                ? [
                    {
                      key: 'website',
                      label: t('connectors.website'),
                      control: (
                        <Button
                          size="sm"
                          appearance="outline"
                          tone="neutral"
                          leadingIcon={RiExternalLinkLine}
                          onPress={() => Linking.openURL(websiteUrl)}
                        >
                          {websiteHost}
                        </Button>
                      ),
                    },
                  ]
                : []),
            ],
          },
          {
            key: 'tools',
            label: t('connectors.skills'),
            rows: tools.length
              ? tools.map((tool) => ({
                  key: tool.name,
                  label: tool.name,
                  description: tool.description,
                }))
              : [
                  {
                    key: 'none',
                    label: t('settings.connections.noTools'),
                    description: connected
                      ? undefined
                      : t('connectors.connectToSeeTools'),
                  },
                ],
          },
        ]}
      />

      <Dialog
        open={envDialogOpen}
        onClose={() => setEnvDialogOpen(false)}
        placement={{ base: 'bottom', md: 'center' }}
        maxWidth={384}
        title={t('connectors.installName', { name: entry.name })}
        description={t('connectors.installEnvDescription')}
        actions={[
          { label: t('common.cancel'), color: 'cancel', disabled: pending },
          {
            label: pending
              ? t('connectors.installing')
              : t('connectors.install'),
            onPress: handleInstallWithEnv,
            disabled: pending,
            // The install is in flight when this runs and the label reports it.
            shouldCloseOnPress: false,
          },
        ]}
      >
        <View className="gap-3">
          {entry.requiredEnv.map((envKey) => (
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
                  envKey.toLowerCase().includes('key') ||
                  envKey.toLowerCase().includes('token')
                }
              />
            </View>
          ))}
        </View>
      </Dialog>
    </>
  );
}
