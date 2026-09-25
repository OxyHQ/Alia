/**
 * `expo-localization` under vitest. Its native module does not exist in this
 * runner, and the package reaches for it at import — which took down any suite
 * that mounted a component calling the real `useTranslation`. The device is
 * American English here, the app's default locale, so a test reads the words
 * the shipped `en.json` gives a person.
 */
export function getLocales() {
  return [{ languageTag: 'en-US', languageCode: 'en', regionCode: 'US' }];
}
