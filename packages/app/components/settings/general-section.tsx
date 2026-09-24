import { useSubscription } from '@/lib/hooks/use-billing';
import { useCredits } from '@/lib/hooks/use-credits';
import { useTranslation } from '@/lib/hooks/use-translation';
import { Button } from '@oxy.so/bloom/button';
import {
  SettingsGeneralPage,
  type SettingsPageSection,
} from '@oxy.so/bloom/settings-modal';
import { APP_COLOR_NAMES, useBloomTheme } from '@oxy.so/bloom/theme';
import { getNativeLanguageName } from '@oxy.so/core';
import { useOxy } from '@oxy.so/services';
import { useRouter } from 'expo-router';
import { SettingsPreferenceSelect } from './preference-select';
import { useAliaSettings } from './settings-context';

/**
 * The story's General page: the plan card, then the limits row, then the
 * app's own preferences. Signed out there is no plan and no limits.
 */
export function GeneralSection() {
  const { mode, setMode, colorPreset, setColorPreset } = useBloomTheme();
  const { currentLanguage, currentLanguages, showBottomSheet, isAuthenticated } =
    useOxy();
  const { afterClose, open } = useAliaSettings();
  const { data: subscription } = useSubscription();
  const { data: credits } = useCredits();
  const router = useRouter();
  const { t } = useTranslation();
  const languages = currentLanguages.length
    ? currentLanguages
    : [currentLanguage];

  const plan = subscription?.plan;
  const price =
    plan && plan.price > 0
      ? new Intl.NumberFormat(undefined, {
          style: 'currency',
          currency: plan.currency,
          maximumFractionDigits: 0,
        }).format(plan.price)
      : null;

  const sections: SettingsPageSection[] = [
    ...(isAuthenticated
      ? [
          {
            key: 'limits',
            rows: [
              {
                key: 'limits',
                label: t('settings.general.limits'),
                description:
                  credits === undefined
                    ? undefined
                    : t('settings.general.creditsLeft', { count: credits.credits }),
                control: (
                  <Button
                    size="sm"
                    appearance="outline"
                    tone="neutral"
                    onPress={() => open('usage')}
                  >
                    {t('settings.general.manageLimits')}
                  </Button>
                ),
              },
            ],
          },
        ]
      : []),
    {
      key: 'app',
      label: t('settings.groups.app'),
      rows: [
        {
          key: 'language',
          label: t('settings.appLanguage.title'),
          description: t('settings.appLanguage.description'),
          control: (
            <Button
              size="sm"
              appearance="outline"
              tone="neutral"
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
                label: value.charAt(0).toUpperCase() + value.slice(1),
              }))}
            />
          ),
        },
      ],
    },
  ];

  return (
    <SettingsGeneralPage
      plan={
        isAuthenticated
          ? {
              badge: t('settings.general.currentPlan'),
              title: price
                ? `${plan?.name} ${price}/${plan?.billingPeriod === 'annual' ? t('settings.general.perYear') : t('settings.general.perMonth')}`
                : (plan?.name ?? t('settings.general.freePlan')),
              description: plan
                ? t('settings.general.creditsPerMonth', { count: plan.creditsPerMonth })
                : undefined,
              action: (
                <Button
                  size="sm"
                  appearance="outline"
                  tone="neutral"
                  onPress={() =>
                    afterClose(() => router.push('/(biglayout)/subscribe'))
                  }
                >
                  {t('sidebar.upgradeToPro')}
                </Button>
              ),
            }
          : undefined
      }
      sections={sections}
    />
  );
}
