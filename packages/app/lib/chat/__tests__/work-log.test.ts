import { describe, expect, it, vi } from 'vitest';

import type { ToolInvocation } from '@/lib/types/messages';

/*
 * The icons are the real Bloom modules' names, stubbed only because
 * `react-native` does not load under node; the mapping hands them over by
 * identity, which is what these tests compare.
 */
const ICONS = ['RiBookOpenLine', 'RiFileTextLine', 'RiGlobalLine', 'RiSearchLine', 'RiTerminalBoxLine', 'RiToolsLine'];
for (const name of ICONS) {
  vi.doMock(`@oxy.so/bloom/icons/${name}`, () => ({ [name]: { icon: name } }));
}
vi.mock('@alia.onl/sdk', () => ({ getToolLabel: (name: string) => name }));

const { isWebInvocation, taskListLog, webSearchLog } = await import('../work-log');
const RiBookOpenLine = { icon: 'RiBookOpenLine' };
const RiFileTextLine = { icon: 'RiFileTextLine' };
const RiGlobalLine = { icon: 'RiGlobalLine' };
const RiSearchLine = { icon: 'RiSearchLine' };
const RiToolsLine = { icon: 'RiToolsLine' };

/** Echoes the key and its params, so an assertion reads which string was asked for. */
const t = (key: string, params?: Record<string, unknown>) =>
  params ? `${key}${JSON.stringify(params)}` : key;

/** A `webSearch` result exactly as `packages/api/src/lib/tools/web-search.ts` returns it. */
const search: ToolInvocation = {
  toolCallId: 's1',
  toolName: 'webSearch',
  state: 'result',
  args: { query: 'best budget mechanical keyboard' },
  result: {
    count: 3,
    results: [
      { title: 'The best budget keyboards', url: 'https://www.pcgamer.com/best', snippet: '…', faviconUrl: 'https://clarity.test/favicons/www.pcgamer.com' },
      { title: 'Keyboards under $100?', url: 'https://old.reddit.com/r/keyboards/1', snippet: '' },
      { title: 'The best budget keyboards', url: 'https://www.pcgamer.com/best', snippet: 'dupe' },
    ],
  },
};

describe('tool calls → WebSearch steps and sources', () => {
  it('draws a search with its query, its result count and its sources', () => {
    const log = webSearchLog([search], undefined, t);
    expect(log.steps).toEqual([
      {
        label: 'chat.bloom.searchedWeb',
        query: 'best budget mechanical keyboard',
        icon: RiSearchLine,
        meta: 'chat.bloom.resultCount{"count":3}',
        sources: [
          { title: 'The best budget keyboards', domain: 'www.pcgamer.com', href: 'https://www.pcgamer.com/best', faviconUrl: 'https://clarity.test/favicons/www.pcgamer.com' },
          { title: 'Keyboards under $100?', domain: 'old.reddit.com', href: 'https://old.reddit.com/r/keyboards/1', brand: 'reddit', faviconUrl: 'https://api.clarity.surf/favicons/old.reddit.com' },
        ],
      },
    ]);
    // A step with sources is two units, and both events have arrived.
    expect(log.revealed).toBe(2);
  });

  it('draws page visits (webScraper, browse read) with the domain and the page as the source', () => {
    const scrape: ToolInvocation = {
      toolCallId: 'w1',
      toolName: 'webScraper',
      state: 'result',
      args: { url: 'https://docs.example.com/guide' },
      result: { documentId: 'd', title: 'Guide', content: '…', url: 'https://docs.example.com/guide', length: 1 },
    };
    const browseRead: ToolInvocation = {
      toolCallId: 'b1',
      toolName: 'browse',
      state: 'result',
      args: { action: 'read', url: 'https://github.com/oxy/bloom' },
      result: { action: 'read', title: 'oxy/bloom', content: '…', url: 'https://github.com/oxy/bloom' },
    };
    const log = webSearchLog([scrape, browseRead], undefined, t);
    expect(log.steps.map((s) => [s.label, s.query, s.icon])).toEqual([
      ['chat.bloom.visited', 'docs.example.com', RiGlobalLine],
      ['chat.bloom.visited', 'github.com', RiGlobalLine],
    ]);
    expect(log.steps[1].sources).toEqual([
      { title: 'oxy/bloom', domain: 'github.com', href: 'https://github.com/oxy/bloom', brand: 'github', faviconUrl: 'https://api.clarity.surf/favicons/github.com' },
    ]);
    expect(log.revealed).toBe(4);
  });

  it('reads browse searches as searches', () => {
    const browseSearch: ToolInvocation = {
      toolCallId: 'b2',
      toolName: 'browse',
      state: 'result',
      args: { action: 'search', query: 'aula f75' },
      result: { action: 'search', results: [{ title: 'A', url: 'https://a.test/', snippet: '' }], count: 1 },
    };
    const [step] = webSearchLog([browseSearch], undefined, t).steps;
    expect(step.label).toBe('chat.bloom.searchedWeb');
    expect(step.query).toBe('aula f75');
    expect(step.meta).toBe('chat.bloom.resultCount{"count":1}');
  });

  it('shows a running search without a count or sources, and one still streaming its args as not yet revealed', () => {
    const running: ToolInvocation = { toolCallId: 'r', toolName: 'webSearch', state: 'call', args: { query: 'q2' } };
    const streaming: ToolInvocation = { toolCallId: 'p', toolName: 'webSearch', state: 'partial-call', args: {} };
    const log = webSearchLog([search, running, streaming], undefined, t);
    expect(log.steps).toHaveLength(3);
    expect(log.steps[1]).toEqual({ label: 'chat.bloom.searchedWeb', query: 'q2', icon: RiSearchLine });
    // search (2 units) + running (1) — the partial call is known but not revealed.
    expect(log.revealed).toBe(3);
  });

  it('says a search failed rather than drawing it like one with missing sources', () => {
    const failed: ToolInvocation = { ...search, result: { error: 'boom', results: [], count: 0 } };
    const [step] = webSearchLog([failed], undefined, t).steps;
    expect(step.meta).toBe(t('chat.bloom.searchFailed'));
    expect(step.sources).toBeUndefined();
  });

  it('says a search found nothing', () => {
    const empty: ToolInvocation = { ...search, result: { results: [], count: 0 } };
    const [step] = webSearchLog([empty], undefined, t).steps;
    expect(step.meta).toBe(t('chat.bloom.noResults'));
    expect(step.sources).toBeUndefined();
  });

  it('draws a persisted deep research run with its searches and its cited sources', () => {
    const research: ToolInvocation = {
      toolCallId: 'research-1',
      toolName: 'deepResearch',
      state: 'result',
      args: { query: 'solid state batteries' },
      result: {
        status: 'complete',
        totalSearches: 12,
        sources: [
          { id: 2, url: 'https://b.test/2', title: 'Second' },
          { id: 1, url: 'https://a.test/1', title: 'First' },
        ],
      },
    };
    const [step] = webSearchLog([research], undefined, t).steps;
    expect(step).toEqual({
      label: 'chat.bloom.researched',
      query: 'solid state batteries',
      icon: RiBookOpenLine,
      meta: 'chat.bloom.searchCount{"count":12}',
      sources: [
        { title: 'First', domain: 'a.test', href: 'https://a.test/1', faviconUrl: 'https://api.clarity.surf/favicons/a.test' },
        { title: 'Second', domain: 'b.test', href: 'https://b.test/2', faviconUrl: 'https://api.clarity.surf/favicons/b.test' },
      ],
    });
  });

  it('draws live research progress before the answer is saved, and drops it once the invocation exists', () => {
    const live = { currentQuery: 'battery density 2026', sourcesFound: 4, sources: [{ id: 1, url: 'https://a.test/1', title: 'First' }] };
    const [step] = webSearchLog([], live, t).steps;
    expect(step).toEqual({
      label: 'chat.bloom.researching',
      query: 'battery density 2026',
      icon: RiBookOpenLine,
      meta: 'chat.bloom.sourceCount{"count":4}',
      sources: [{ title: 'First', domain: 'a.test', href: 'https://a.test/1', faviconUrl: 'https://api.clarity.surf/favicons/a.test' }],
    });
    const saved: ToolInvocation = { toolCallId: 'r', toolName: 'deepResearch', state: 'result', args: { query: 'x' }, result: { sources: [] } };
    const log = webSearchLog([saved], live, t);
    expect(log.steps.map((s) => s.label)).toEqual(['chat.bloom.researched']);
    // The live sources still fill in what the saved invocation lacks.
    expect(log.steps[0].sources).toEqual([{ title: 'First', domain: 'a.test', href: 'https://a.test/1', faviconUrl: 'https://api.clarity.surf/favicons/a.test' }]);
  });

  it('ignores every other tool', () => {
    const file: ToolInvocation = { toolCallId: 'f', toolName: 'generateFile', state: 'result', args: {}, result: {} };
    expect(webSearchLog([file], undefined, t)).toEqual({ steps: [], revealed: 0 });
    expect(isWebInvocation(file)).toBe(false);
    expect(isWebInvocation(search)).toBe(true);
  });
});

describe('tool calls → TaskList tasks', () => {
  it('titles a generateFile task from task-utils and chips the file it created', () => {
    const file: ToolInvocation = {
      toolCallId: 'f',
      toolName: 'generateFile',
      state: 'result',
      args: { filename: 'report.csv', content: 'a,b', format: 'csv' },
      result: { filename: 'report.csv', format: 'csv', content: 'a,b', message: 'Generated report.csv' },
    };
    const log = taskListLog([file], false, t);
    expect(log.tasks).toEqual([
      {
        title: 'Generated file',
        runningTitle: 'Generating file',
        icon: RiFileTextLine,
        steps: [{ label: 'chat.bloom.createdFile', chips: [{ label: 'report.csv' }] }],
      },
    ]);
    expect(log.revealed).toBe(2);
  });

  it('chips short string arguments, and says how a call that did not succeed ended', () => {
    const failed: ToolInvocation = {
      toolCallId: 'e',
      toolName: 'sendEmail',
      state: 'result',
      args: { to: 'ana@example.com', subject: 'Hi', body: 'x'.repeat(500) },
      result: { error: 'SMTP refused' },
    };
    const cut: ToolInvocation = { toolCallId: 'c', toolName: 'customThing', state: 'call', args: { count: 3 } };
    const log = taskListLog([failed, cut], false, t);
    expect(log.tasks[0]).toEqual({
      title: 'Email',
      runningTitle: 'Email',
      icon: RiToolsLine,
      steps: [
        { label: 'chat.bloom.taskInput', chips: [{ label: 'Hi' }, { label: 'ana@example.com' }] },
        { label: 'chat.bloom.taskFailed' },
      ],
    });
    // The turn is over and this call never returned.
    expect(log.tasks[1]).toEqual({
      title: 'Custom Thing',
      runningTitle: 'Custom Thing',
      icon: RiToolsLine,
      steps: [{ label: 'chat.bloom.taskStopped' }],
    });
    expect(log.revealed).toBe(3 + 2);
  });

  it('leaves web calls to WebSearch and stops revealing at a call still streaming', () => {
    const memory: ToolInvocation = { toolCallId: 'm', toolName: 'userMemory', state: 'result', args: {}, result: {} };
    const pending: ToolInvocation = { toolCallId: 'p', toolName: 'shellExec', state: 'partial-call', args: {} };
    const log = taskListLog([search, memory, pending], true, t);
    expect(log.tasks.map((task) => task.title)).toEqual(['Remembered', 'Ran command']);
    expect(log.revealed).toBe(1);
  });
});
