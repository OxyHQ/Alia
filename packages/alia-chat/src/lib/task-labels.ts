import { englishWorkLog, type Translate } from './work-log-copy';

/** Tools that have a name of their own in the catalogue. Others are named from their id. */
const NAMED_PILL = new Set([
  'browse',
  'webSearch',
  'webScraper',
  'generateFile',
  'sendTelegramMessage',
  'sendSlack',
  'sendDiscord',
  'sendSignal',
  'sendEmail',
  'delegateToAgent',
  'askAgent',
  // The API's app router: the model opening a connected app whose tools did not all fit in
  // one request.
  'useApps',
  'agentSearch',
  'userMemory',
  'shellExec',
  'fileEdit',
  'codeInterpreter',
]);

/** Tools whose finished label differs from the running one; the rest read the same. */
const NAMED_DONE = new Set([
  'browse',
  'webScraper',
  'generateFile',
  'delegateToAgent',
  'askAgent',
  'useApps',
  'agentSearch',
  'userMemory',
  'shellExec',
  'fileEdit',
  'codeInterpreter',
]);

/** A tool's short label, in the reader's language when a translator is given. */
export function getToolPillLabel(toolName: string, t: Translate = englishWorkLog): string {
  if (NAMED_PILL.has(toolName)) return t(`tasks.tool.pill.${toolName}`);

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
  return NAMED_DONE.has(toolName)
    ? t(`tasks.tool.done.${toolName}`)
    : getToolPillLabel(toolName, t);
}
