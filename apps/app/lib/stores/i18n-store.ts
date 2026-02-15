import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { getLocales } from 'expo-localization';
import i18n from '@/lib/i18n';

function getDeviceLocale(): string {
  const locales = getLocales();
  if (!locales || locales.length === 0) return 'en-US';
  return locales[0]?.languageTag || locales[0]?.languageCode || 'en';
}

interface I18nState {
  locale: string;
  setLocale: (locale: string) => void;
}

export const useI18nStore = create<I18nState>()(
  persist(
    (set) => ({
      locale: getDeviceLocale(),
      setLocale: (locale: string) => {
        i18n.locale = locale;
        set({ locale });
      },
    }),
    {
      name: 'i18n-storage',
      storage: createJSONStorage(() => AsyncStorage),
      onRehydrateStorage: () => (state) => {
        if (state?.locale) {
          i18n.locale = state.locale;
        }
      },
    }
  )
);
