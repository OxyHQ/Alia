import { useTranslation } from '@/lib/hooks/use-translation';
import { Button } from '@oxy.so/bloom/button';
import { SettingsGeneralPage } from '@oxy.so/bloom/settings-modal';
import { APP_COLOR_NAMES, useBloomTheme } from '@oxy.so/bloom/theme';
import { getNativeLanguageName } from '@oxy.so/core';
import { useOxy } from '@oxy.so/services';
import { SettingsPreferenceSelect } from './preference-select';
import { useAliaSettings } from './settings-context';

export function GeneralSection() {
  const { mode, setMode, colorPreset, setColorPreset } = useBloomTheme();
  const { currentLanguage, currentLanguages, showBottomSheet } = useOxy();
  const { afterClose } = useAliaSettings();
  const { t } = useTranslation();
  const languages = currentLanguages.length
    ? currentLanguages
    : [currentLanguage];
  return (
    <SettingsGeneralPage
      sections={[
        {
          key: 'general',
          rows: [
            {
              key: 'language',
              label: t('settings.appLanguage.title'),
              description: t('settings.appLanguage.description'),
              control: (
                <Button
                  variant="secondary"
                  size="sm"
                  onPress={() =>
                    afterClose(() => showBottomSheet?.('LanguageSelector'))
                  }
                >
                  {languages.map(getNativeLanguageName).join(', ')}
                </Button>
              ),
            },
            {
              key: 'appearance',
              label: t('settings.appearance.title'),
              control: (
                <SettingsPreferenceSelect
                  label={t('settings.appearance.title')}
                  value={mode}
                  onChange={setMode}
                  items={[
                    { value: 'system', label: t('settings.appearance.system') },
                    { value: 'light', label: t('settings.appearance.light') },
                    { value: 'dark', label: t('settings.appearance.dark') },
                  ]}
                />
              ),
            },
            {
              key: 'color',
              label: t('settings.accentColor.title'),
              control: (
                <SettingsPreferenceSelect
                  label={t('settings.accentColor.title')}
                  value={colorPreset}
                  onChange={setColorPreset}
                  items={APP_COLOR_NAMES.map((value) => ({
                    value,
                    label: value,
                  }))}
                />
              ),
            },
          ],
        },
      ]}
    />
  );
}
