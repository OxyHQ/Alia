import { englishWorkLog, type Translate } from './work-log-copy';

/** Whether the catalogue names this tool itself; otherwise the label is made from its id. */
function isNamed(kind: 'pill' | 'done', toolName: string): boolean {
  const key = `tasks.tool.${kind}.${toolName}`;
  return englishWorkLog(key) !== key;
}

/** A tool's short label, in the reader's language when a translator is given. */
export function getToolPillLabel(toolName: string, t: Translate = englishWorkLog): string {
  if (isNamed('pill', toolName)) return t(`tasks.tool.pill.${toolName}`);

  // Oxy service tools: oxy_serviceName__toolName → "ServiceName"
  if (toolName.startsWith('oxy_')) {
    const parts = toolName.replace('oxy_', '').split('__');
    return (parts[0] ?? '').replace(/[-_]/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
  }

  // Fallback: camelCase → "Camel Case"
  return toolName
    .replace(/([A-Z])/g, ' $1')
    .replace(/^./, (c) => c.toUpperCase())
    .trim();
}

/**
 * The finished form of a tool's label, for a task whose call has returned (`TaskList` swaps
 * `runningTitle` for this once the task's steps land). Labels that are already names
 * ("Telegram", "Email") read the same either way, so they fall back to the running label.
 */
export function getToolDoneLabel(toolName: string, t: Translate = englishWorkLog): string {
  return isNamed('done', toolName)
    ? t(`tasks.tool.done.${toolName}`)
    : getToolPillLabel(toolName, t);
}
