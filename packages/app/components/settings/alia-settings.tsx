import { bloomIcon } from '@/components/sidebar/bloom-icon';
import { useTranslation } from '@/lib/hooks/use-translation';
import { useDialogControl } from '@oxy.so/bloom/dialog';
import {
  SettingsModal,
  type SettingsModalPage,
} from '@oxy.so/bloom/settings-modal';
import { useOxy } from '@oxy.so/services';
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { AccountsSection } from './accounts-section';
import { BillingSection } from './billing-section';
import { BotsSection } from './bots-section';
import { ConnectorDetailSection } from './connector-detail-section';
import { ConnectorsSection } from './connectors-section';
import { GeneralSection } from './general-section';
import { IntegrationsSection } from './integrations-section';
import { LocalModelsSection } from './local-models-section';
import { MemorySection } from './memory-section';
import { PersonalizationSection } from './personalization-section';
import { SETTINGS_GROUPS } from './sections';
import { SecuritySection } from './security-section';
import { AliaSettingsContext } from './settings-context';
import { WritingStyleSection } from './writing-style-section';

const CONTENT: Record<string, ReactNode> = {
  general: <GeneralSection />,
  personalization: <PersonalizationSection />,
  accounts: <AccountsSection />,
  bots: <BotsSection />,
  connectors: <ConnectorsSection />,
  integrations: <IntegrationsSection />,
  'local-models': <LocalModelsSection />,
  usage: <BillingSection />,
  security: <SecuritySection />,
  memory: <MemorySection />,
  'writing-style': <WritingStyleSection />,
};
export function AliaSettingsProvider({ children }: { children: ReactNode }) {
  const control = useDialogControl();
  const { isAuthenticated } = useOxy();
  const { t } = useTranslation();
  const [page, setPage] = useState('general');
  const [request, setRequest] = useState({
    sequence: 0,
    initialView: 'navigation' as 'navigation' | 'page',
  });
  const [params, setParams] = useState<Record<string, string>>({});
  const pending = useRef<(() => void) | null>(null);
  const groups = useMemo(
    () =>
      SETTINGS_GROUPS.map((group) => ({
        label: t(group.titleKey),
        items: group.sections
          .filter((section) => isAuthenticated || section.id === 'general')
          .map((section) => ({
            key: section.id,
            page: section.id,
            label: t(section.labelKey),
            icon: bloomIcon(section.icon),
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
  const open = useCallback(
    (next?: string, nextParams: Record<string, string> = {}) => {
      const target = next && next in pages ? next : 'general';
      setPage(target);
      setParams(nextParams);
      setRequest((previous) => ({
        sequence: previous.sequence + 1,
        initialView: next ? 'page' : 'navigation',
      }));
    },
    [pages],
  );
  useEffect(() => {
    if (request.sequence > 0) control.open();
  }, [request, control]);
  const close = useCallback(() => control.close(), [control]);
  const afterClose = useCallback(
    (action: () => void) => {
      pending.current = action;
      control.close();
    },
    [control],
  );
  const value = useMemo(
    () => ({ open, close, afterClose, params }),
    [open, close, afterClose, params],
  );
  return (
    <AliaSettingsContext.Provider value={value}>
      {children}
      <SettingsModal
        control={control}
        groups={groups}
        pages={pages}
        page={page in pages ? page : 'general'}
        onPageChange={setPage}
        initialView={request.initialView}
        labels={{ dialog: t('settings.title') }}
        onClose={() => {
          const action = pending.current;
          pending.current = null;
          action?.();
        }}
      />
    </AliaSettingsContext.Provider>
  );
}
