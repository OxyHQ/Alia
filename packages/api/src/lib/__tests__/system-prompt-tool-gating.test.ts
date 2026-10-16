import { describe, expect, it, vi } from 'vitest';

vi.mock('../tools/oxy-services.js', () => ({
  getOxyServicePromptFragment: vi.fn(() => ''),
  getOxyServiceContext: vi.fn(async () => ''),
}));

const { SystemPromptBuilder } = await import('../system-prompt-builder.js');

/**
 * The prompt describes a tool only when the turn registered it, and everything
 * that changes per turn comes AFTER everything that does not, so a provider's
 * prefix cache can serve the head of the message.
 */

const BROWSER_RULE = 'Use `browser_action` for ALL web navigation';

describe('prompt text that names a tool', () => {
  it('loads Cowork browser rules only when browser_action is registered', async () => {
    const without = await SystemPromptBuilder.build({
      surface: 'cowork',
      isDirectUserSession: false,
      toolNames: ['read_file'],
    });
    const none = await SystemPromptBuilder.build({ surface: 'cowork', isDirectUserSession: false });
    const withTool = await SystemPromptBuilder.build({
      surface: 'cowork',
      isDirectUserSession: false,
      toolNames: ['browser_action'],
    });
    expect(without).not.toContain(BROWSER_RULE);
    expect(none).not.toContain(BROWSER_RULE);
    expect(withTool).toContain(BROWSER_RULE);
  });

  it('never names the messaging, agent-mode or clock tools itself', async () => {
    const prompt = await SystemPromptBuilder.build({
      isDirectUserSession: true,
      toolNames: ['sendTelegramMessage', 'searchAgents', 'consultAgent', 'getCurrentDate'],
    });
    for (const name of [
      'sendTelegramMessage',
      'getWhatsAppChats',
      'searchAgents',
      'getCurrentDate',
    ]) {
      expect(prompt).not.toContain(name);
    }
  });

  it('layers the question rule from the registered tool name alone', async () => {
    const prompt = await SystemPromptBuilder.build({
      isDirectUserSession: true,
      toolNames: ['askUserQuestion'],
    });
    expect(prompt).toContain('Asking the person (`askUserQuestion`)');
  });
});

describe('prompt cache layout', () => {
  it('keeps every per-turn part after the static head', async () => {
    const quiet = await SystemPromptBuilder.build({ isDirectUserSession: true });
    const busy = await SystemPromptBuilder.build({
      isDirectUserSession: true,
      oxyUser: { name: { full: 'Ada Lovelace' } },
      recalledMemories: [{ title: 'Tea', summary: 'prefers green tea' }],
      userMemory: { preferences: { diet: 'vegan' } },
    });
    // The head is byte-identical; only the tail differs.
    const head = quiet.slice(0, quiet.indexOf('Today is'));
    expect(head.length).toBeGreaterThan(500);
    expect(busy.startsWith(head)).toBe(true);
    expect(busy.indexOf('Ada Lovelace')).toBeGreaterThan(head.length);
    expect(busy.indexOf('green tea')).toBeGreaterThan(head.length);
    expect(busy.indexOf('vegan')).toBeGreaterThan(head.length);
  });

  it('puts the date after the skills index and the Apps catalogue', async () => {
    const prompt = await SystemPromptBuilder.build({
      isDirectUserSession: true,
      appCatalog: '\n\n## Apps\n- inbox',
      skills: { index: '\n\n## Skills\n- pdf: reads PDFs', active: '' },
    });
    const date = prompt.indexOf('Today is');
    expect(prompt.indexOf('## Apps')).toBeLessThan(date);
    expect(prompt.indexOf('## Skills')).toBeLessThan(date);
  });
});
