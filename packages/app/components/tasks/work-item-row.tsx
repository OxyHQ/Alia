import { AutomationCard } from '@/components/automations/automation-card';
import { TaskCard } from '@/components/tasks/task-card';
import type { AutomationDefinition } from '@/lib/automations/types';
import type { WorkItem } from '@/lib/automations/work-items';
import { useAgentActivity } from '@/lib/hooks/use-agent-activity';
import type { TaskSession } from '@/lib/hooks/use-tasks';

/** Wrapper that subscribes to real-time activity for a single active task */
function ActiveTaskCard({
  task,
  onPress,
}: {
  task: TaskSession;
  onPress: () => void;
}) {
  const activity = useAgentActivity(
    task.status === 'running' ? task._id : null,
    task.agentId?._id ?? null,
  );
  return <TaskCard task={task} activity={activity} onPress={onPress} />;
}

/**
 * One row of the work list: a session an agent ran — live while it runs — or
 * an automation with its controls.
 */
export function WorkItemRow({
  item,
  agentName,
  busyId,
  onTaskPress,
  onToggleAutomation,
  onRunAutomation,
  onStopAutomation,
  onViewAutomationHistory,
}: {
  item: WorkItem;
  agentName: (agentId: string) => string;
  /** The automation whose control is in flight; every row's are disabled meanwhile. */
  busyId: string | null;
  onTaskPress: (task: TaskSession) => void;
  onToggleAutomation: (automation: AutomationDefinition, enabled: boolean) => void;
  onRunAutomation: (automation: AutomationDefinition) => void;
  onStopAutomation: (automation: AutomationDefinition) => void;
  onViewAutomationHistory: (automation: AutomationDefinition) => void;
}) {
  if (item.kind === 'task') {
    return item.task.status === 'running' || item.task.status === 'queued' ? (
      <ActiveTaskCard task={item.task} onPress={() => onTaskPress(item.task)} />
    ) : (
      <TaskCard task={item.task} onPress={() => onTaskPress(item.task)} />
    );
  }
  return (
    <AutomationCard
      variant="compact"
      automation={item.automation}
      latestRun={item.latestRun}
      agentName={agentName}
      busy={busyId === item.id}
      controlsDisabled={busyId !== null}
      onToggle={onToggleAutomation}
      onRun={onRunAutomation}
      onStop={onStopAutomation}
      onViewHistory={onViewAutomationHistory}
    />
  );
}
