import { useCallback } from 'react';
import { Pressable, View } from 'react-native';
import { ChevronRight, Globe2 } from 'lucide-react-native';
import { Text } from '@/components/ui/text';
import { useTranslation } from '@/lib/hooks/use-translation';
import { useOxy } from '@oxy.so/services';
import { getNativeLanguageName } from '@oxy.so/core';

/**
 * The app's UI language is an Oxy-account concern, not Alia's: Oxy already
 * resolves it (the account's primary locale when signed in, otherwise the
 * device/guest locale) and ships the picker that reads and writes it
 * (`LanguageSelectorScreen`, opened here the same way every other Oxy-owned
 * surface is — `showBottomSheet('LanguageSelector')`, exactly like
 * `ManageAccount` elsewhere in Settings). This row keeps only the label and
 * description; the multi-select account-aware picker itself lives in the SDK.
 */
export function LanguageSelector() {
  const { t } = useTranslation();
  const { showBottomSheet, currentLanguage, currentLanguages } = useOxy();

  const openLanguageSelector = useCallback(() => {
    showBottomSheet?.('LanguageSelector');
  }, [showBottomSheet]);

  // Account locales when there are any (signed in, or a guest override was
  // set), else the single resolved device/fallback locale — the same
  // fallback `LanguageSelectorScreen` itself uses.
  const selectedLanguages = currentLanguages.length > 0 ? currentLanguages : [currentLanguage];
  const languageDescription = selectedLanguages.map((code) => getNativeLanguageName(code)).join(', ');

  return (
    <View className="gap-2">
      <View className="flex-row items-center gap-2">
        <Globe2 size={20} className="text-primary" />
        <Text className="text-base font-semibold">{t('settings.appLanguage.title')}</Text>
      </View>
      <Text className="text-sm text-muted-foreground">
        {t('settings.appLanguage.description')}
      </Text>
      <Pressable
        onPress={openLanguageSelector}
        className="border border-border rounded-lg px-4 py-3 bg-background flex-row items-center justify-between"
      >
        <Text className="text-foreground">{languageDescription}</Text>
        <ChevronRight size={20} className="text-muted-foreground" />
      </Pressable>
    </View>
  );
}
