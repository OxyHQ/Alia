import { generateAPIUrl } from '@/shared/api/generate-api-url';
import { useTranslation } from '@/shared/i18n/use-translation';
import { useUserData } from '@/features/memory/runtime/use-user-data';
import { useUserDataStore } from '@/features/memory/runtime/user-data-store';
import {
  SettingsCard,
  SettingsPageActions,
  SettingsRow,
  type SettingsRowData,
} from '@oxy.so/bloom/settings-modal';
import { SettingsSelect } from '@oxy.so/bloom/settings-modal/rows';
import { toast } from '@oxy.so/bloom/toast';
import { useOxy } from '@oxy.so/services/ui/client';
import { useEffect, useMemo, useState } from 'react';
import { View } from 'react-native';
import { usePersonalityStyleRow } from './personality-style-picker';

/** How much Alia says by default: the closed set the API stores (`short`, `medium`, `long`). */
const RESPONSE_LENGTHS = ['short', 'medium', 'long'] as const;
type ResponseLength = (typeof RESPONSE_LENGTHS)[number];

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
  // '' is no choice: the person gets Alia's own measure.
  const [length, setLength] = useState<ResponseLength | ''>('');

  useEffect(() => {
    if (memory) {
      setLanguage(memory.preferences?.language || '');
      setTone(memory.preferences?.tone || '');
      setVoice(memory.preferences?.voice || '');
      setLength(memory.preferences?.responseLength || '');
    }
  }, [memory]);

  const handleCancel = () => {
    if (memory) {
      setLanguage(memory.preferences?.language || '');
      setTone(memory.preferences?.tone || '');
      setVoice(memory.preferences?.voice || '');
      setLength(memory.preferences?.responseLength || '');
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
        // The preferences are replaced as a whole, so the length goes with them or a save
        // would clear it. No choice is left out (the stored set has no empty value).
        body: JSON.stringify({
          language,
          tone,
          voice,
          ...(length ? { responseLength: length } : {}),
        }),
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

  // What changed since the stored preferences, so the header offers Save only when there is one.
  const dirty =
    memory != null &&
    (language !== (memory?.preferences?.language || '') ||
      tone !== (memory?.preferences?.tone || '') ||
      voice !== (memory?.preferences?.voice || '') ||
      length !== (memory?.preferences?.responseLength || ''));
  const pageActions = useMemo(
    () => [
      {
        key: 'cancel',
        label: t('common.cancel'),
        onPress: handleCancel,
        disabled: saving || !dirty,
      },
      {
        key: 'save',
        label: saving ? t('settings.saving') : t('settings.saveButton'),
        onPress: handleSave,
        disabled: saving || !dirty,
      },
    ],
    // `handleCancel` and `handleSave` close over this render's state; the actions follow it.
    // biome-ignore lint/correctness/useExhaustiveDependencies: see above
    [t, saving, dirty, language, tone, voice, length, memory],
  );

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
          // The default is no language chosen: Alia answers in the language the person writes in,
          // which is their own (nothing is added to the prompt). Picking one overrides that.
          items={[{ value: '', label: t('settings.aliaLanguage.auto') }, ...LANGUAGES]}
        />
      ),
    },
    {
      key: 'length',
      label: t('settings.responseLength.title'),
      description: t('settings.responseLength.description'),
      control: (
        <SettingsSelect
          label={t('settings.responseLength.title')}
          value={length}
          onChange={(value) => setLength(value as ResponseLength | '')}
          items={[
            { value: '', label: t('settings.responseLength.auto') },
            ...RESPONSE_LENGTHS.map((value) => ({
              value,
              label: t(`settings.responseLength.${value}`),
            })),
          ]}
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
      <SettingsPageActions label={t('settings.title')} actions={pageActions} />
      <SettingsCard>
        {rows.map((row) => (
          <SettingsRow key={row.key} label={row.label} description={row.description}>
            {row.control}
          </SettingsRow>
        ))}
      </SettingsCard>
    </View>
  );
}
