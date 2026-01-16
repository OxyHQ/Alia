import { View, Pressable } from 'react-native';
import { Text } from '@/components/ui/text';
import { useTranslation } from '@/hooks/useTranslation';
import { ChevronDown, Check, Globe2 } from 'lucide-react-native';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';

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
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Pressable className="border border-border rounded-lg px-4 py-3 bg-background flex-row items-center justify-between">
            <Text className="text-foreground">{getCurrentLocaleLabel()}</Text>
            <ChevronDown size={20} className="text-muted-foreground" />
          </Pressable>
        </DropdownMenuTrigger>
        <DropdownMenuContent className="w-64">
          {SUPPORTED_LOCALES.map((lang) => (
            <DropdownMenuItem key={lang.code} onPress={() => changeLocale(lang.code)}>
              <View className="flex-row items-center justify-between flex-1">
                <View>
                  <Text>{lang.nativeLabel}</Text>
                  {lang.label !== lang.nativeLabel && (
                    <Text className="text-xs text-muted-foreground">{lang.label}</Text>
                  )}
                </View>
                {locale === lang.code && <Check size={16} className="text-primary" />}
              </View>
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
    </View>
  );
}
