/**
 * The words of the work log (`work-log.ts`), keyed the way the Alia app's own catalogue keys
 * them, so the app hands its translator straight in. A host without one gets English.
 */
export type Translate = (key: string, params?: Record<string, unknown>) => string;

type Entry = string | { one: string; other: string };

const CATALOGUE: Record<string, Entry> = {
  'chat.bloom.researched': 'Researched',
  'chat.bloom.searchCount': { one: '1 search', other: '{{count}} searches' },
  'chat.bloom.searchedWeb': 'Searched the web for',
  'chat.bloom.searchFailed': 'Search failed',
  'chat.bloom.noResults': 'No results',
  'chat.bloom.resultCount': { one: '1 result', other: '{{count}} results' },
  'chat.bloom.visited': 'Visited',
  'chat.bloom.researching': 'Researching',
  'chat.bloom.sourceCount': { one: '1 source', other: '{{count}} sources' },
  'chat.bloom.createdFile': 'Created',
  'chat.bloom.writingFile': 'Writing',
  'chat.bloom.taskInput': 'With',
  'chat.bloom.taskFailed': 'Returned an error',
  'chat.bloom.taskStopped': "Didn't finish",
  'tasks.tool.pill.browse': 'Browsing',
  'tasks.tool.pill.webSearch': 'Web search',
  'tasks.tool.pill.webScraper': 'Reading page',
  'tasks.tool.pill.generateFile': 'Generating file',
  'tasks.tool.pill.sendTelegramMessage': 'Telegram',
  'tasks.tool.pill.sendSlack': 'Slack',
  'tasks.tool.pill.sendDiscord': 'Discord',
  'tasks.tool.pill.sendSignal': 'Signal',
  'tasks.tool.pill.sendEmail': 'Email',
  'tasks.tool.pill.delegateToAgent': 'Delegating',
  'tasks.tool.pill.askAgent': 'Asking an agent',
  'tasks.tool.pill.useApps': 'Opening apps',
  'tasks.tool.pill.agentSearch': 'Searching agents',
  'tasks.tool.pill.userMemory': 'Remembering',
  'tasks.tool.pill.shellExec': 'Running command',
  'tasks.tool.pill.fileEdit': 'Editing file',
  'tasks.tool.pill.codeInterpreter': 'Running code',
  'tasks.tool.done.browse': 'Browsed',
  'tasks.tool.done.webScraper': 'Read page',
  'tasks.tool.done.generateFile': 'Generated file',
  'tasks.tool.done.delegateToAgent': 'Delegated',
  'tasks.tool.done.askAgent': 'Asked an agent',
  'tasks.tool.done.useApps': 'Opened apps',
  'tasks.tool.done.agentSearch': 'Searched agents',
  'tasks.tool.done.userMemory': 'Remembered',
  'tasks.tool.done.shellExec': 'Ran command',
  'tasks.tool.done.fileEdit': 'Edited file',
  'tasks.tool.done.codeInterpreter': 'Ran code',
};

/** The default translator: the English above, with `{{count}}` plurals. */
export const englishWorkLog: Translate = (key, params) => {
  const entry = CATALOGUE[key];
  if (entry === undefined) return key;
  const count = typeof params?.count === 'number' ? params.count : undefined;
  const text = typeof entry === 'string' ? entry : count === 1 ? entry.one : entry.other;
  return text.replace('{{count}}', String(count ?? ''));
};
