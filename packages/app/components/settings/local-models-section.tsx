import {
  LocalRuntimeProbeError,
  useLocalRuntimeProbe,
} from '@/lib/hooks/use-local-runtime';
import { useTranslation } from '@/lib/hooks/use-translation';
import {
  DEFAULT_LOCAL_ENDPOINT,
  useLocalRuntimeStore,
} from '@/lib/stores/local-runtime-store';
import { Button } from '@oxy.so/bloom/button';
import {
  SettingsGeneralPage,
  SettingsTextField,
  SettingsValueField,
} from '@oxy.so/bloom/settings-modal';
import { Switch } from '@oxy.so/bloom/switch';
import { useTheme } from '@oxy.so/bloom/theme';
import { useState } from 'react';
import { Platform } from 'react-native';

/** The origin Ollama has to be told to accept, quoted back as a runnable command. */
function browserOrigin(): string {
  if (Platform.OS !== 'web' || typeof window === 'undefined') return '';
  return window.location.origin;
}

/** Safari is the one desktop browser that refuses a localhost request from an https page. */
function isSafari(): boolean {
  if (Platform.OS !== 'web' || typeof navigator === 'undefined') return false;
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
  const failure =
    probe.error instanceof LocalRuntimeProbeError ? probe.error : null;
  const unknownFailure =
    probe.error instanceof Error && failure === null ? probe.error : null;
  const failureText =
    failure === null
      ? null
      : failure.reason === 'unreachable'
        ? t('settings.localModels.unreachable', { endpoint })
        : failure.reason === 'refused'
          ? t('settings.localModels.refused', { endpoint })
          : failure.reason === 'http'
            ? t('settings.localModels.httpError', { status: failure.status })
            : t('settings.localModels.empty');

  return (
    <SettingsGeneralPage
      sections={[
        {
          key: 'runtime',
          description: t('settings.localModels.description'),
          rows: [
            {
              key: 'enabled',
              label: t('settings.localModels.enable'),
              description: t('settings.localModels.enableHint'),
              control: (
                <Switch
                  accessibilityLabel={t('settings.localModels.enable')}
                  value={consent === 'granted'}
                  onValueChange={(on) =>
                    setConsent(on ? 'granted' : 'declined')
                  }
                />
              ),
            },
            ...(consent === 'granted'
              ? [
                  {
                    key: 'endpoint',
                    label: t('settings.localModels.endpoint'),
                    description: t('settings.localModels.endpointHint'),
                    control: (
                      <SettingsTextField
                        label={t('settings.localModels.endpoint')}
                        value={draftEndpoint}
                        onCommit={(value) => {
                          setDraftEndpoint(value);
                          setEndpoint(value.trim() || DEFAULT_LOCAL_ENDPOINT);
                        }}
                        placeholder={DEFAULT_LOCAL_ENDPOINT}
                        showSavedToast={false}
                      />
                    ),
                  },
                  {
                    key: 'name',
                    label: t('settings.localModels.deviceName'),
                    description: t('settings.localModels.deviceNameHint'),
                    control: (
                      <SettingsTextField
                        label={t('settings.localModels.deviceName')}
                        value={label}
                        onCommit={setLabel}
                        showSavedToast={false}
                      />
                    ),
                  },
                  {
                    key: 'test',
                    label: models.length
                      ? t('settings.localModels.connected', {
                          count: models.length,
                        })
                      : t('settings.localModels.notConnected'),
                    control: (
                      <Button
                        size="sm"
                        variant="secondary"
                        disabled={probe.isFetching}
                        onPress={() => {
                          setEndpoint(
                            draftEndpoint.trim() || DEFAULT_LOCAL_ENDPOINT,
                          );
                          void probe.refetch();
                        }}
                      >
                        {probe.isFetching
                          ? t('settings.localModels.testing')
                          : t('settings.localModels.test')}
                      </Button>
                    ),
                  },
                  ...(failureText || unknownFailure
                    ? [
                        {
                          key: 'error',
                          label: failureText ?? unknownFailure!.message,
                          description:
                            failure?.reason === 'unreachable'
                              ? t('settings.localModels.unreachableHint')
                              : undefined,
                        },
                      ]
                    : []),
                  ...(failure?.reason === 'refused' && origin
                    ? [
                        {
                          key: 'origin',
                          label: t('settings.localModels.refusedHint'),
                          description: t('settings.localModels.command', {
                            origin,
                          }),
                        },
                      ]
                    : []),
                  ...(isSafari()
                    ? [
                        {
                          key: 'safari',
                          label: t('settings.localModels.safariHint'),
                        },
                      ]
                    : []),
                ]
              : []),
          ],
        },
        ...(consent === 'granted' && models.length
          ? [
              {
                key: 'models',
                label: t('settings.localModels.modelsTitle'),
                description: t('settings.localModels.freeNote'),
                rows: models.map((model) => ({
                  key: model,
                  label: model,
                  control: (
                    <SettingsValueField>
                      {t('settings.localModels.free')}
                    </SettingsValueField>
                  ),
                })),
              },
            ]
          : []),
      ]}
    />
  );
}
