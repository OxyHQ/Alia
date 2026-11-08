import { generateAPIUrl } from '@/shared/api/generate-api-url';
import { useTranslation } from '@/shared/i18n/use-translation';
import { useUserData } from '@/features/memory/runtime/use-user-data';
import { useUserDataStore } from '@/features/memory/runtime/user-data-store';
import { ButtonGroup, ButtonGroupItem } from '@oxy.so/bloom/button-group';
import { SettingsCard, SettingsRow, type SettingsRowData } from '@oxy.so/bloom/settings-modal';
import { SettingsSelect } from '@oxy.so/bloom/settings-modal/rows';
import { toast } from '@oxy.so/bloom/toast';
import { useOxy } from '@oxy.so/services/ui/client';
import { useEffect, useState } from 'react';
import { View } from 'react-native';
import { usePersonalityStyleRow } from './personality-style-picker';

const LANGUAGES = [
  { value: 'en-US', label: 'English' },
  { value: 'es-ES', label: 'Español' },
  { value: 'fr-FR', label: 'Français' },
  { value: 'de-DE', label: 'Deutsch' },
  { value: 'it-IT', label: 'Italiano' },
  { value: 'pt-BR', label: 'Português' },
  { value: 'zh-CN', label: '中文' },
  { value: 'ja-JP', label: '日本語' },
  { value: 'ko-KR', label: '한국어' },
  { value: 'ru-RU', label: 'Русский' },
  { value: 'ar-SA', label: 'العربية' },
  { value: 'hi-IN', label: 'हिन्दी' },
];

export function PersonalizationSection() {
  const { isAuthenticated, oxyServices } = useOxy();
  const { memory } = useUserData();
  const setMemory = useUserDataStore((state) => state.setMemory);
  const [saving, setSaving] = useState(false);
  const { t } = useTranslation();

  const [language, setLanguage] = useState('');
  const [tone, setTone] = useState('');
  const [voice, setVoice] = useState('');

  useEffect(() => {
    if (memory) {
      setLanguage(memory.preferences?.language || '');
      setTone(memory.preferences?.tone || '');
      setVoice(memory.preferences?.voice || '');
    }
  }, [memory]);

  const handleCancel = () => {
    if (memory) {
      setLanguage(memory.preferences?.language || '');
      setTone(memory.preferences?.tone || '');
      setVoice(memory.preferences?.voice || '');
    }
  };

  const handleSave = async () => {
    if (!isAuthenticated) return;

    setSaving(true);
    try {
      const token = oxyServices.session.accessToken;
      const authHeaders: Record<string, string> = {
        'Content-Type': 'application/json',
      };
      if (token) authHeaders['Authorization'] = `Bearer ${token}`;

      const response = await fetch(generateAPIUrl('/memory/preferences'), {
        method: 'PUT',
        headers: authHeaders,
        body: JSON.stringify({ language, tone, voice }),
      });

      if (response.ok) {
        setMemory(await response.json());
        toast.success(t('settings.saveSuccess'));
      } else {
        toast.error(t('settings.saveFailed'));
      }
    } catch (error) {
      console.error('Error saving memory:', error);
      toast.error(t('settings.saveFailed'));
    } finally {
      setSaving(false);
    }
  };

  const personalityRow = usePersonalityStyleRow({
    selectedStyle: tone,
    onSelectStyle: setTone,
  });

  const rows: SettingsRowData[] = [
    {
      key: 'language',
      label: t('settings.aliaLanguage.title'),
      description: t('settings.aliaLanguage.description'),
      control: (
        <SettingsSelect
          label={t('settings.aliaLanguage.title')}
          value={language}
          onChange={setLanguage}
          items={LANGUAGES}
        />
      ),
    },
    {
      key: 'voice',
      label: t('settings.voicePreference.title'),
      description: t('settings.voicePreference.description'),
      control: (
        <SettingsSelect
          label={t('settings.voicePreference.title')}
          value={voice || 'female'}
          onChange={setVoice}
          items={[
            { value: 'female', label: t('settings.voicePreference.female') },
            { value: 'male', label: t('settings.voicePreference.male') },
          ]}
        />
      ),
    },
    personalityRow,
  ];

  return (
    <View className="w-full gap-6">
      <SettingsCard>
        {rows.map((row) => (
          <SettingsRow key={row.key} label={row.label} description={row.description}>
            {row.control}
          </SettingsRow>
        ))}
      </SettingsCard>
      <SettingsCard>
        <SettingsRow label={t('settings.saveButton')}>
          <ButtonGroup size="sm" accessibilityLabel={t('settings.saveButton')}>
            <ButtonGroupItem onPress={handleCancel} disabled={saving}>
              {t('common.cancel')}
            </ButtonGroupItem>
            <ButtonGroupItem onPress={handleSave} disabled={saving}>
              {saving ? t('settings.saving') : t('settings.saveButton')}
            </ButtonGroupItem>
          </ButtonGroup>
        </SettingsRow>
      </SettingsCard>
    </View>
  );
}
