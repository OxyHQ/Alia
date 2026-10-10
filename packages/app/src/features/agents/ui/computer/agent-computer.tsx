import { useState } from 'react';
import { ScrollView, View } from 'react-native';
import { Chip } from '@oxy.so/bloom/chip';
import { EmptyState } from '@oxy.so/bloom/empty-state';
import { RiComputerLine } from '@oxy.so/bloom/icons/RiComputerLine';
import { Loading } from '@oxy.so/bloom/loading';
import { Muted } from '@oxy.so/bloom/typography';
import { AgentDetailSection } from '@/features/agents/ui/detail/agent-detail-section';
import { BrowserLiveView } from '@/features/agents/ui/computer/browser-live-view';
import { ComputerActivity } from '@/features/agents/ui/computer/computer-activity';
import { WorkspaceFiles } from '@/features/agents/ui/computer/workspace-files';
import {
  useAgentComputer,
  useAppActive,
  useBrowserScreenshot,
  useComputerActions,
  useComputerReceipts,
  useWorkspaceFiles,
} from '@/features/agents/runtime/use-agent-computer';
import { errorMessage } from '@/shared/api/error-utils';
import { useTranslation } from '@/shared/i18n/use-translation';
import { useIsLargeScreen } from '@/shared/platform/use-is-large-screen';
import { useScreenOnShow } from '@/shared/platform/use-screen-on-show';

/**
 * The agent's computer, as the person it works for sees it: its browser live
 * (and theirs to take over for a login), its `/workspace`, and what it
 * recently ran. Only ever the caller's own computer with this agent.
 */
export function AgentComputer({ agentId }: { agentId: string }) {
  const { t } = useTranslation();
  const isLargeScreen = useIsLargeScreen();
  const onShow = useScreenOnShow();
  const appActive = useAppActive();
  const live = onShow && appActive;
  const [path, setPath] = useState('/workspace');
  const [actionError, setActionError] = useState<string | null>(null);

  const computer = useAgentComputer(agentId, live);
  const browserOpen = computer.data?.browser.state === 'open';
  const screenshot = useBrowserScreenshot(agentId, live && browserOpen);
  const receipts = useComputerReceipts(agentId, live);
  const running = computer.data?.computer.state === 'running';
  const files = useWorkspaceFiles(agentId, path, Boolean(running));
  const actions = useComputerActions(agentId);

  const busy =
    actions.input.isPending ||
    actions.control.isPending ||
    actions.navigate.isPending ||
    actions.open.isPending;
  const report = (error: unknown) =>
    setActionError(t('agents.computer.browser.actionFailed', { reason: errorMessage(error) }));
  const run =
    <T,>(
      mutate: (
        value: T,
        options: { onError: (error: unknown) => void; onSuccess: () => void },
      ) => void,
    ) =>
    (value: T) => {
      setActionError(null);
      mutate(value, { onError: report, onSuccess: () => setActionError(null) });
    };

  if (computer.isPending) {
    return (
      <View className="flex-1 items-center justify-center">
        <Loading variant="spinner" text={t('common.loading')} />
      </View>
    );
  }

  if (computer.isError || !computer.data) {
    const status = (computer.error as { response?: { status?: number } } | null)?.response?.status;
    return (
      <EmptyState
        icon={RiComputerLine}
        title={status === 404 ? t('agents.computer.unavailable') : t('agents.computer.loadFailed')}
      />
    );
  }

  const { browser, granted } = computer.data;
  const state = computer.data.computer.state;

  return (
    <ScrollView className="flex-1" showsVerticalScrollIndicator={false} testID="agent-computer">
      <View className={isLargeScreen ? 'w-full max-w-[960px] gap-6 p-4' : 'w-full gap-6 p-4'}>
        <View className="gap-2">
          <Muted>{t('agents.computer.subtitle')}</Muted>
          <View className="flex-row">
            <Chip size="large">{t(`agents.computer.state.${state}`)}</Chip>
          </View>
          {!granted ? <Muted>{t('agents.computer.notGranted')}</Muted> : null}
        </View>

        <AgentDetailSection title={t('agents.computer.browser.title')}>
          <BrowserLiveView
            browser={browser}
            screenshot={screenshot.data}
            screenshotFailed={screenshot.isError}
            busy={busy}
            error={actionError}
            onInput={run(actions.input.mutate)}
            onControl={run(actions.control.mutate)}
            onNavigate={run(actions.navigate.mutate)}
            onOpen={run(actions.open.mutate)}
          />
        </AgentDetailSection>

        <AgentDetailSection title={t('agents.computer.files.title')}>
          <WorkspaceFiles
            running={Boolean(running)}
            path={path}
            listing={files.data}
            loading={files.isFetching}
            starting={actions.start.isPending}
            onOpenDirectory={setPath}
            onStart={() => actions.start.mutate()}
          />
        </AgentDetailSection>

        <AgentDetailSection title={t('agents.computer.activity.title')}>
          <ComputerActivity receipts={receipts.data} />
        </AgentDetailSection>
      </View>
    </ScrollView>
  );
}
