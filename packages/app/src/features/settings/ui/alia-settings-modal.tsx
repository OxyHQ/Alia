import { useTranslation } from '@/shared/i18n/use-translation';
import type { DialogControlProps } from '@oxy.so/bloom/dialog';
import { SettingsModal, type SettingsModalPage } from '@oxy.so/bloom/settings-modal';
import { useEffect, useMemo, type ReactNode } from 'react';
import { AccountsSection } from './accounts-section';
import { BillingSection } from './billing-section';
import { ConnectorDetailSection } from './connector-detail-section';
import { ConnectorsSection } from './connectors-section';
import { GeneralSection } from './general-section';
import { LocalModelsSection } from './local-models-section';
import { MemorySection } from './memory-section';
import { PersonalizationSection } from './personalization-section';
import { ProactiveSection } from './proactive-section';
import { SETTINGS_GROUPS } from './sections';
import { SecuritySection } from './security-section';
import { visibleSettingsSections } from './settings-pages';
import { SkillsSection } from './skills-section';
import { StorageSection } from './storage-section';
import { UsageSection } from './usage-section';
import { WritingStyleSection } from './writing-style-section';

const CONTENT: Record<string, ReactNode> = {
  general: <GeneralSection />,
  storage: <StorageSection />,
  personalization: <PersonalizationSection />,
  accounts: <AccountsSection />,
  connectors: <ConnectorsSection />,
  'local-models': <LocalModelsSection />,
  usage: <BillingSection />,
  limits: <UsageSection />,
  security: <SecuritySection />,
  memory: <MemorySection />,
  proactive: <ProactiveSection />,
  'writing-style': <WritingStyleSection />,
  skills: <SkillsSection />,
};

export interface AliaSettingsModalProps {
  control: DialogControlProps;
  isAuthenticated: boolean;
  page: string;
  onPageChange: (page: string) => void;
  initialView: 'navigation' | 'page';
  /** Bumped by every `open()`; the modal opens itself for each new value. */
  openSequence: number;
  onClose: () => void;
}

/**
 * The settings modal and every page in it: its own chunk (`alia-settings.tsx` loads it), because
 * no first paint shows it and its pages bring the billing contracts, connectors and the rest.
 */
export function AliaSettingsModal({
  control,
  isAuthenticated,
  page,
  onPageChange,
  initialView,
  openSequence,
  onClose,
}: AliaSettingsModalProps) {
  const { t } = useTranslation();
  const groups = useMemo(
    () =>
      SETTINGS_GROUPS.map((group) => ({
        label: t(group.titleKey),
        items: visibleSettingsSections(group.sections, isAuthenticated).map((section) => ({
          key: section.id,
          page: section.id,
          label: t(section.labelKey),
          icon: section.icon,
        })),
      })).filter((group) => group.items.length),
    [isAuthenticated, t],
  );
  const pages = useMemo(
    () => ({
      ...(isAuthenticated
        ? {
            'connector-detail': {
              title: t('connectors.detailTitle'),
              content: <ConnectorDetailSection />,
            },
          }
        : {}),
      ...Object.fromEntries(
        groups.flatMap((group) =>
          group.items.map((item) => [
            item.key,
            {
              title: item.label,
              content: CONTENT[item.key],
            } satisfies SettingsModalPage,
          ]),
        ),
      ),
    }),
    [groups, isAuthenticated, t],
  );
  // After this commit, so the page and view the request asked for are the ones the modal opens on.
  useEffect(() => {
    if (openSequence > 0) control.open();
  }, [openSequence, control]);
  return (
    <SettingsModal
      control={control}
      groups={groups}
      pages={pages}
      page={page in pages ? page : 'general'}
      onPageChange={onPageChange}
      initialView={initialView}
      labels={{ dialog: t('settings.title') }}
      headerPresentation="floating"
      onClose={onClose}
    />
  );
}
