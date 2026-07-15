import { View, Pressable } from 'react-native';
import { Text } from '@/components/ui/text';
import { useTranslation } from '@/lib/hooks/use-translation';
import { ChevronDown, Globe2 } from 'lucide-react-native';
import * as DropdownMenu from '@/components/ui/dropdown-menu';

const SUPPORTED_LOCALES = [
  { code: 'en-US', label: 'English', nativeLabel: 'English' },
  { code: 'en-GB', label: 'English (UK)', nativeLabel: 'English (UK)' },
  { code: 'es-ES', label: 'Spanish', nativeLabel: 'Español' },
  { code: 'es-MX', label: 'Spanish (Mexico)', nativeLabel: 'Español (México)' },
];

export function LanguageSelector() {
  const { locale, changeLocale, t } = useTranslation();

  const getCurrentLocaleLabel = () => {
    const current = SUPPORTED_LOCALES.find((l) => l.code === locale);
    return current?.nativeLabel || SUPPORTED_LOCALES[0].nativeLabel;
  };

  return (
    <View className="gap-2">
      <View className="flex-row items-center gap-2">
        <Globe2 size={20} className="text-primary" />
        <Text className="text-base font-semibold">{t('settings.appLanguage.title')}</Text>
      </View>
      <Text className="text-sm text-muted-foreground">
        {t('settings.appLanguage.description')}
      </Text>
      <DropdownMenu.Root>
        <DropdownMenu.Trigger>
          <Pressable className="border border-border rounded-lg px-4 py-3 bg-background flex-row items-center justify-between">
            <Text className="text-foreground">{getCurrentLocaleLabel()}</Text>
            <ChevronDown size={20} className="text-muted-foreground" />
          </Pressable>
        </DropdownMenu.Trigger>
        <DropdownMenu.Content>
          {SUPPORTED_LOCALES.map((lang) => (
            <DropdownMenu.CheckboxItem
              key={lang.code}
              value={locale === lang.code ? 'on' : 'off'}
              onValueChange={() => changeLocale(lang.code)}
            >
              <DropdownMenu.ItemIndicator />
              <DropdownMenu.ItemTitle>{lang.nativeLabel}</DropdownMenu.ItemTitle>
              {lang.label !== lang.nativeLabel && (
                <DropdownMenu.ItemSubtitle>{lang.label}</DropdownMenu.ItemSubtitle>
              )}
            </DropdownMenu.CheckboxItem>
          ))}
        </DropdownMenu.Content>
      </DropdownMenu.Root>
    </View>
  );
}
