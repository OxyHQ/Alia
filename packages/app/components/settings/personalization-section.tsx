import { generateAPIUrl } from '@/lib/generate-api-url';
import { useTranslation } from '@/lib/hooks/use-translation';
import { useUserData } from '@/lib/hooks/use-user-data';
import { useUserDataStore } from '@/lib/stores/user-data-store';
import { ButtonGroup, ButtonGroupItem } from '@oxy.so/bloom/button-group';
import {
  SettingsCard,
  SettingsRow,
  SettingsSection,
  SettingsTextField,
  type SettingsRowData,
} from '@oxy.so/bloom/settings-modal';
import { Textarea } from '@oxy.so/bloom/textarea';
import { toast } from '@oxy.so/bloom/toast';
import { useOxy } from '@oxy.so/services';
import { useEffect, useState } from 'react';
import { View } from 'react-native';
import { usePersonalityStyleRow } from './personality-style-picker';
import { SettingsPreferenceSelect } from './preference-select';

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

type FieldKey = 'occupation' | 'location' | 'bio' | 'interests';

const FIELDS: {
  key: FieldKey;
  titleKey: string;
  descriptionKey: string;
  placeholderKey: string;
  multiline?: boolean;
}[] = [
  {
    key: 'occupation',
    titleKey: 'settings.occupation.title',
    descriptionKey: 'settings.occupation.description',
    placeholderKey: 'settings.occupation.placeholder',
  },
  {
    key: 'location',
    titleKey: 'settings.location.title',
    descriptionKey: 'settings.location.description',
    placeholderKey: 'settings.location.placeholder',
  },
  {
    key: 'bio',
    titleKey: 'settings.aboutYou.title',
    descriptionKey: 'settings.aboutYou.description',
    placeholderKey: 'settings.aboutYou.placeholder',
    multiline: true,
  },
  {
    key: 'interests',
    titleKey: 'settings.interests.title',
    descriptionKey: 'settings.interests.description',
    placeholderKey: 'settings.interests.placeholder',
    multiline: true,
  },
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
  const [occupation, setOccupation] = useState('');
  const [location, setLocation] = useState('');
  const [bio, setBio] = useState('');
  const [interests, setInterests] = useState('');

  const fieldValues: Record<FieldKey, string> = {
    occupation,
    location,
    bio,
    interests,
  };
  const fieldSetters: Record<FieldKey, (value: string) => void> = {
    occupation: setOccupation,
    location: setLocation,
    bio: setBio,
    interests: setInterests,
  };

  useEffect(() => {
    if (memory) {
      setLanguage(memory.preferences?.language || '');
      setTone(memory.preferences?.tone || '');
      setVoice(memory.preferences?.voice || '');
      setOccupation(memory.context?.occupation || '');
      setLocation(memory.context?.location || '');
      setBio(memory.context?.bio || '');
      setInterests(memory.preferences?.interests?.join(', ') || '');
    }
  }, [memory]);

  const handleCancel = () => {
    if (memory) {
      setLanguage(memory.preferences?.language || '');
      setTone(memory.preferences?.tone || '');
      setVoice(memory.preferences?.voice || '');
      setOccupation(memory.context?.occupation || '');
      setLocation(memory.context?.location || '');
      setBio(memory.context?.bio || '');
      setInterests(memory.preferences?.interests?.join(', ') || '');
    }
  };

  const handleSave = async () => {
    if (!isAuthenticated) return;

    setSaving(true);
    try {
      const token = oxyServices.getAccessToken();
      const authHeaders: Record<string, string> = {
        'Content-Type': 'application/json',
      };
      if (token) authHeaders['Authorization'] = `Bearer ${token}`;

      const prefRes = await fetch(generateAPIUrl('/memory/preferences'), {
        method: 'PUT',
        headers: authHeaders,
        body: JSON.stringify({
          language,
          tone,
          voice,
          interests: interests
            .split(',')
            .map((i) => i.trim())
            .filter(Boolean),
        }),
      });

      const contextRes = await fetch(generateAPIUrl('/memory/context'), {
        method: 'PUT',
        headers: authHeaders,
        body: JSON.stringify({ occupation, location, bio }),
      });

      if (prefRes.ok && contextRes.ok) {
        const updatedMemory = await contextRes.json();
        setMemory(updatedMemory);
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
        <SettingsPreferenceSelect
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
        <SettingsPreferenceSelect
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
    // SettingsProfilePage's own page geometry (full width, cards 24 apart),
    // spelled out because two of its blocks are free-text sections, not rows.
    <View className="w-full gap-6">
      <SettingsCard>
        {rows.map((row) => (
          <SettingsRow
            key={row.key}
            label={row.label}
            description={row.description}
          >
            {row.control}
          </SettingsRow>
        ))}
      </SettingsCard>
      <SettingsCard>
        {FIELDS.filter((field) => !field.multiline).map(
          ({ key, titleKey, descriptionKey, placeholderKey }) => (
            <SettingsRow
              key={key}
              label={t(titleKey)}
              description={t(descriptionKey)}
            >
              <SettingsTextField
                label={t(titleKey)}
                placeholder={t(placeholderKey)}
                value={fieldValues[key]}
                onCommit={fieldSetters[key]}
                showSavedToast={false}
              />
            </SettingsRow>
          ),
        )}
      </SettingsCard>
      {FIELDS.filter((field) => field.multiline).map(
        ({ key, titleKey, descriptionKey, placeholderKey }) => (
          <SettingsSection
            key={key}
            label={t(titleKey)}
            description={t(descriptionKey)}
          >
            <Textarea
              accessibilityLabel={t(titleKey)}
              placeholder={t(placeholderKey)}
              value={fieldValues[key]}
              onChangeText={fieldSetters[key]}
              autoResize
              rows={3}
              maxRows={8}
            />
          </SettingsSection>
        ),
      )}
      <SettingsCard>
        <SettingsRow label={t('settings.saveButton')}>
          <ButtonGroup
            size="sm"
            accessibilityLabel={t('settings.saveButton')}
          >
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
