import { extractCitationSources } from '@/lib/citations';
import { getToolDoneLabel, getToolPillLabel } from '@/lib/task-utils';
import { toolCallStatus } from '@/lib/thought-utils';
import type { ToolInvocation } from '@/lib/types/messages';
import { RiBookOpenLine } from '@oxy.so/bloom/icons/RiBookOpenLine';
import { RiFileTextLine } from '@oxy.so/bloom/icons/RiFileTextLine';
import { RiGlobalLine } from '@oxy.so/bloom/icons/RiGlobalLine';
import { RiSearchLine } from '@oxy.so/bloom/icons/RiSearchLine';
import { RiTerminalBoxLine } from '@oxy.so/bloom/icons/RiTerminalBoxLine';
import { RiToolsLine } from '@oxy.so/bloom/icons/RiToolsLine';
import type { TaskListChip, TaskListStep, TaskListTask } from '@oxy.so/bloom/task-list';
import type { WebSearchBrand, WebSearchSource, WebSearchStep } from '@oxy.so/bloom/web-search';

/**
 * A turn's tool calls, as the two Bloom logs draw them.
 *
 * Where the turn WENT (searches, page visits, research) is a `WebSearch`
 * trail; what it DID with every other tool is a `TaskList`. Calls that return
 * a card (weather, market…) are neither — the caller filters them out first.
 *
 * Both logs count UNITS and are driven by `revealed`, never by their own
 * ticker: a unit counts as revealed only when the event that produced it has
 * arrived. A call whose arguments are still streaming (`partial-call`) is a
 * step that is known but not yet revealed, so the log shimmers on it and shows
 * its Working tail; a step's sources are a unit that exists only once the
 * result carried them.
 */

type Translate = (key: string, params?: Record<string, unknown>) => string;

/** The research the live stream reports before the answer is persisted. */
export interface LiveResearch {
  currentQuery?: string;
  sourcesFound?: number;
  sources?: Array<{ id?: unknown; url?: unknown; title?: unknown }> | null;
}

/** Tools whose calls are a place the turn went, not a task it did. */
const WEB_TOOLS = new Set(['webSearch', 'browse', 'webScraper', 'deepResearch']);

export function isWebInvocation(inv: Pick<ToolInvocation, 'toolName'>): boolean {
  return WEB_TOOLS.has(inv.toolName);
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

function domainOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}

/** The site marks Bloom draws, by registrable domain. Anything else is a quiet dot. */
const BRANDS: Array<[string, WebSearchBrand]> = [
  ['github.com', 'github'],
  ['gitlab.com', 'gitlab'],
  ['bitbucket.org', 'bitbucket'],
  ['x.com', 'x'],
  ['twitter.com', 'x'],
  ['reddit.com', 'reddit'],
  ['facebook.com', 'facebook'],
  ['instagram.com', 'instagram'],
  ['linkedin.com', 'linkedin'],
  ['tiktok.com', 'tiktok'],
  ['spotify.com', 'spotify'],
  ['twitch.tv', 'twitch'],
  ['notion.so', 'notion'],
  ['notion.site', 'notion'],
  ['figma.com', 'figma'],
  ['apple.com', 'apple'],
  ['microsoft.com', 'microsoft'],
  ['google.com', 'google'],
  ['discord.com', 'discord'],
  ['slack.com', 'slack'],
  ['dropbox.com', 'dropbox'],
  ['telegram.org', 'telegram'],
  ['t.me', 'telegram'],
  ['whatsapp.com', 'whatsapp'],
  ['amazon.com', 'amazon'],
];

function brandOf(domain: string): WebSearchBrand | undefined {
  const host = domain.toLowerCase();
  return BRANDS.find(([site]) => host === site || host.endsWith(`.${site}`))?.[1];
}

function source(url: string, title?: string): WebSearchSource {
  const domain = domainOf(url);
  const brand = brandOf(domain);
  return { title: title ?? domain, domain, href: url, ...(brand ? { brand } : {}) };
}

function uniqueSources(list: WebSearchSource[]): WebSearchSource[] {
  const seen = new Set<string>();
  return list.filter((s) => {
    const key = s.href ?? s.title;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function succeeded(inv: ToolInvocation): boolean {
  return toolCallStatus(inv, true) === 'done';
}

function isSearch(inv: ToolInvocation): boolean {
  if (inv.toolName === 'webSearch') return true;
  const action = str(inv.result?.action) ?? str(inv.args?.action);
  return inv.toolName === 'browse' && action === 'search';
}

/** One step, and whether the event that produced it has arrived. */
interface MappedStep {
  step: WebSearchStep;
  arrived: boolean;
}

function webStep(inv: ToolInvocation, live: LiveResearch | undefined, t: Translate): MappedStep {
  const arrived = inv.state !== 'partial-call';
  const ok = succeeded(inv);

  if (inv.toolName === 'deepResearch') {
    const cited = extractCitationSources([inv], live?.sources);
    const searches = typeof inv.result?.totalSearches === 'number' ? inv.result.totalSearches : 0;
    return {
      arrived,
      step: {
        label: t('chat.bloom.researched'),
        query: str(inv.args?.query),
        icon: RiBookOpenLine,
        ...(searches > 0 ? { meta: t('chat.bloom.searchCount', { count: searches }) } : {}),
        ...(cited.length > 0 ? { sources: cited.map((c) => source(c.url, c.title)) } : {}),
      },
    };
  }

  if (isSearch(inv)) {
    const results: unknown[] = ok && Array.isArray(inv.result?.results) ? inv.result.results : [];
    const sources = uniqueSources(
      results.flatMap((r) => {
        const url = str((r as { url?: unknown })?.url);
        return url ? [source(url, str((r as { title?: unknown }).title))] : [];
      }),
    );
    const count = typeof inv.result?.count === 'number' ? inv.result.count : results.length;
    return {
      arrived,
      step: {
        label: t('chat.bloom.searchedWeb'),
        query: str(inv.args?.query),
        icon: RiSearchLine,
        // Say what came back, including nothing: a search that found nothing or
        // failed must not look like one whose sources are missing.
        ...(inv.state !== 'result'
          ? {}
          : !ok
            ? { meta: t('chat.bloom.searchFailed') }
            : count === 0
              ? { meta: t('chat.bloom.noResults') }
              : { meta: t('chat.bloom.resultCount', { count }) }),
        ...(sources.length > 0 ? { sources } : {}),
      },
    };
  }

  // A page visit: `webScraper`, or `browse` reading a URL.
  const url = str(inv.result?.url) ?? str(inv.args?.url);
  return {
    arrived,
    step: {
      label: t('chat.bloom.visited'),
      query: url ? domainOf(url) : undefined,
      icon: RiGlobalLine,
      ...(ok && url && inv.state === 'result' ? { sources: [source(url, str(inv.result?.title))] } : {}),
    },
  };
}

/** How many leading units have arrived. Units are revealed in order, so the first missing one stops the count. */
function arrivedUnits(mapped: MappedStep[]): number {
  let revealed = 0;
  for (const { step, arrived } of mapped) {
    if (!arrived) break;
    revealed += step.sources?.length ? 2 : 1;
  }
  return revealed;
}

export interface WebSearchLog {
  steps: WebSearchStep[];
  revealed: number;
}

/**
 * The `WebSearch` trail of a turn: one step per search, page visit or
 * research run, with the sources each surfaced.
 *
 * `research` is the live `researchProgress` of a research answer. Before the
 * answer is saved there is no `deepResearch` invocation yet, so the progress
 * is the step; once it is saved the invocation is, and the live sources only
 * fill in what the persisted ones lack.
 */
export function webSearchLog(
  invocations: readonly ToolInvocation[] | undefined,
  research: LiveResearch | undefined,
  t: Translate,
): WebSearchLog {
  const web = (invocations ?? []).filter(isWebInvocation);
  const mapped = web.map((inv) => webStep(inv, research, t));

  const hasResearchCall = web.some((inv) => inv.toolName === 'deepResearch');
  if (research && !hasResearchCall) {
    const cited = extractCitationSources(undefined, research.sources);
    const found = typeof research.sourcesFound === 'number' ? research.sourcesFound : cited.length;
    mapped.push({
      arrived: true,
      step: {
        label: t('chat.bloom.researching'),
        query: str(research.currentQuery),
        icon: RiBookOpenLine,
        ...(found > 0 ? { meta: t('chat.bloom.sourceCount', { count: found }) } : {}),
        ...(cited.length > 0 ? { sources: cited.map((c) => source(c.url, c.title)) } : {}),
      },
    });
  }

  return { steps: mapped.map((m) => m.step), revealed: arrivedUnits(mapped) };
}

/** Argument keys worth a chip, in the order they are shown. */
const CHIP_KEYS = ['filename', 'path', 'file', 'command', 'url', 'query', 'name', 'title', 'subject', 'to', 'handle'];
const CHIP_MAX = 60;

function argChips(args: Record<string, unknown> | undefined): TaskListChip[] {
  if (!args) return [];
  const chips: TaskListChip[] = [];
  for (const key of CHIP_KEYS) {
    const value = str(args[key]);
    if (value && value.length <= CHIP_MAX) chips.push({ label: value });
    if (chips.length === 3) break;
  }
  return chips;
}

const TASK_ICONS: Record<string, NonNullable<TaskListTask['icon']>> = {
  generateFile: RiFileTextLine,
  fileEdit: RiFileTextLine,
  shellExec: RiTerminalBoxLine,
  codeInterpreter: RiTerminalBoxLine,
};

export interface TaskListLog {
  tasks: TaskListTask[];
  revealed: number;
}

/**
 * The `TaskList` of a turn: one task per call that is neither a web step nor
 * a card, titled from `lib/task-utils`.
 *
 * Steps come from what the call really carried: its arguments as chips once
 * the call is made (the file name for `generateFile`), and how it ended once
 * the result is in — an error, or a call the turn left behind (`live` false
 * with no result). A successful call adds no "Done" row: the swap from the
 * running title to the finished one already says it.
 */
export function taskListLog(
  invocations: readonly ToolInvocation[] | undefined,
  live: boolean,
  t: Translate,
): TaskListLog {
  let revealed = 0;
  let open = true;
  const tasks = (invocations ?? [])
    .filter((inv) => !isWebInvocation(inv))
    .map((inv): TaskListTask => {
      const status = toolCallStatus(inv, live);
      const steps: TaskListStep[] = [];

      if (inv.toolName === 'generateFile') {
        const name = str(inv.result?.filename) ?? str(inv.args?.filename);
        if (name) steps.push({ label: t(status === 'done' ? 'chat.bloom.createdFile' : 'chat.bloom.writingFile'), chips: [{ label: name }] });
      } else {
        const chips = argChips(inv.args);
        if (chips.length > 0) steps.push({ label: t('chat.bloom.taskInput'), chips });
      }
      if (status === 'error') steps.push({ label: t('chat.bloom.taskFailed') });
      if (status === 'interrupted') steps.push({ label: t('chat.bloom.taskStopped') });

      // Header and argument steps land with the call; the outcome with the result.
      const arrived = inv.state !== 'partial-call';
      if (open && arrived) revealed += 1 + steps.length;
      else open = false;

      return {
        title: getToolDoneLabel(inv.toolName),
        runningTitle: getToolPillLabel(inv.toolName),
        icon: TASK_ICONS[inv.toolName] ?? RiToolsLine,
        steps,
      };
    });
  return { tasks, revealed };
}
