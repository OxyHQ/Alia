import { useUserData } from '@/features/memory/runtime/use-user-data';
import { useUserDataStore } from '@/features/memory/runtime/user-data-store';
import apiClient from '@/shared/api/client';
import { useTranslation } from '@/shared/i18n/use-translation';
import { Button } from '@oxy.so/bloom/button';
import { SettingsCard, SettingsRow } from '@oxy.so/bloom/settings-modal';
import { Switch } from '@oxy.so/bloom/switch';
import { toast } from '@oxy.so/bloom/toast';
import { useAuth, useOxy } from '@oxy.so/services/ui/client';
import * as Linking from 'expo-linking';
import { useEffect, useState } from 'react';
import { View } from 'react-native';
import { RememberingAgentsSection } from './agent-memory-section';

/** This page's own strings. */
const K = 'settings.assistant.memory';

/** What Alia remembers about the person lives in the `memories` database of their Nilo workspace. */
export const NILO_URL = 'https://nilo.so';

export function MemorySection() {
  const { isAuthenticated } = useOxy();
  const { signIn } = useAuth();
  const { memory } = useUserData();
  const setMemory = useUserDataStore((state) => state.setMemory);
  const { t } = useTranslation();
  const [updating, setUpdating] = useState(false);

  useEffect(() => {
    if (!isAuthenticated) {
      signIn().catch(() => {});
    }
  }, [isAuthenticated, signIn]);

  const handleToggleRecall = async (recallEnabled: boolean) => {
    if (!isAuthenticated || !memory) return;

    setUpdating(true);
    try {
      const response = await apiClient.put('/memory/settings', { recallEnabled });
      setMemory({ ...memory, settings: response.data });
    } catch (error) {
      console.error('Error updating memory settings:', error);
      toast.error(t('memory.failedToSaveSettings'));
    } finally {
      setUpdating(false);
    }
  };

  const openNilo = () => {
    Linking.openURL(NILO_URL).catch(() => toast.error(t(`${K}.openNiloFailed`)));
  };

  return (
    <View className="w-full gap-6">
      <SettingsCard>
        <SettingsRow label={t(`${K}.niloTitle`)} description={t(`${K}.niloDescription`)}>
          <Button size="sm" appearance="outline" tone="neutral" onPress={openNilo}>
            {t(`${K}.openNilo`)}
          </Button>
        </SettingsRow>
        <SettingsRow
          label={t('memory.recallToggleLabel')}
          description={t('memory.recallToggleDescription')}
        >
          <Switch
            accessibilityLabel={t('memory.recallToggleLabel')}
            checked={memory?.settings?.recallEnabled ?? true}
            onCheckedChange={handleToggleRecall}
            disabled={updating}
          />
        </SettingsRow>
      </SettingsCard>

      {/* Memory is per actor: Alia's lives in Nilo, each agent's own below. */}
      <RememberingAgentsSection />
    </View>
  );
}
