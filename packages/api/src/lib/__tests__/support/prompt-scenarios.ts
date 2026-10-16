/**
 * What reaches the model on every request, assembled the way the routes do and
 * measured with a real tokenizer.
 *
 * `prompt-budget.test.ts` prints these tables and holds each total under an
 * explicit budget, so a prompt or a tool description cannot grow unnoticed.
 *
 * Tokens are `gpt-tokenizer` (`o200k_base`): exact for OpenAI models, a close
 * proxy for the rest. Tool definitions are counted as the wire carries them,
 * `{ name, description, parameters }` as JSON.
 *
 * Out of scope on purpose: tools the turn's SOURCES contribute at runtime (MCP
 * connectors, integrations, the Oxy-app catalogue, `consultAgent`) and the client's
 * own editor tools. They are not defined in this repository, so they are stubbed
 * to nothing.
 */
import { encode } from 'gpt-tokenizer';
import { asSchema, type ToolSet } from 'ai';

import { wireToolParameters } from '../../inference/kaana-language-model.js';
import { SystemPromptBuilder } from '../../system-prompt-builder.js';
import { ToolPipeline } from '../../tool-pipeline.js';
import { buildIdentityGuard } from '../../identity-guard.js';
import { loadPrompt } from '../../prompt-loader.js';
import { buildSystemPrompt as buildRunnerPrompt } from '../../agent/runner.js';
import { buildRuntimeTools } from '../../agent/actions.js';
import { readCapabilityGrants } from '../../../domain/capability-grants.js';
import type { HydratedAgent } from '../../agent-identity.js';
import type { CatalogueModel } from '../../models/catalogue.js';

export const tokens = (text: string): number => encode(text).length;

export interface ScenarioMeasure {
  name: string;
  /** Tokens of the system message, by section where the assembler can say. */
  sections: Array<[string, number]>;
  systemTokens: number;
  toolTokens: number;
  toolCount: number;
  /** Per-tool tokens, largest first. */
  perTool: Array<[string, number]>;
  total: number;
  /** The assembled system message. */
  system: string;
  /** The tool names in the order the request carries them. */
  toolOrder: string[];
  /** Each tool as the wire carries it. */
  wire: Record<string, string>;
}

async function wireTools(
  tools: ToolSet,
): Promise<{ total: number; per: Array<[string, number]>; wire: Record<string, string> }> {
  const wire: Record<string, string> = {};
  const per: Array<[string, number]> = [];
  for (const [name, t] of Object.entries(tools)) {
    const parameters = wireToolParameters(
      (await asSchema(t.inputSchema as never).jsonSchema) as Record<string, unknown>,
    );
    const json = JSON.stringify({ name, description: t.description, parameters });
    wire[name] = json;
    per.push([name, tokens(json)]);
  }
  const total = per.reduce((sum, [, n]) => sum + n, 0);
  per.sort((a, b) => b[1] - a[1]);
  return { total, per, wire };
}

const MODEL = {
  name: 'GPT-5',
  publisher: { name: 'OpenAI' },
} as unknown as CatalogueModel;

const deviceInfo = { deviceName: 'Phone', osName: 'iOS', osVersion: '19' };
const sseEmitter = { emit: () => undefined };

async function chatTools(opts: { direct: boolean }) {
  return ToolPipeline.forUser({
    userId: 'u1',
    accessToken: 'token',
    isDirectSession: opts.direct,
    actsForPerson: opts.direct,
    requestId: 'r1',
    toolsEnabled: true,
    webSearch: true,
    isLocalRuntime: false,
    sseEmitter: opts.direct ? sseEmitter : undefined,
    deviceInfo: opts.direct ? deviceInfo : undefined,
  });
}

async function finish(
  name: string,
  system: string,
  sections: Array<[string, number]>,
  tools: ToolSet,
): Promise<ScenarioMeasure> {
  const wire = await wireTools(tools);
  const systemTokens = tokens(system);
  return {
    name,
    sections,
    systemTokens,
    toolTokens: wire.total,
    toolCount: wire.per.length,
    perTool: wire.per,
    total: systemTokens + wire.total,
    system,
    toolOrder: Object.keys(tools),
    wire: wire.wire,
  };
}

async function promptSections(
  surface: 'chat' | 'codea' | 'cowork',
  extra: { voice?: boolean; ask?: boolean },
): Promise<Array<[string, number]>> {
  const names = [surface === 'chat' ? 'general' : surface, 'base'];
  if (extra.voice) names.push('voice');
  if (extra.ask && !extra.voice) names.push('ask-user-question');
  const guard = buildIdentityGuard({ modelName: 'GPT-5', publisherName: 'OpenAI' });
  const out: Array<[string, number]> = [['identity guard', tokens(guard)]];
  for (const n of names) out.push([`prompts/${n}.md`, tokens(await loadPrompt(n))]);
  return out;
}

export async function measureScenarios(): Promise<ScenarioMeasure[]> {
  const out: ScenarioMeasure[] = [];

  // 1. Direct app chat, every tool the pipeline can build without a database.
  {
    const { tools, appCatalogPrompt } = await chatTools({ direct: true });
    const system = await SystemPromptBuilder.build({
      surface: 'chat',
      model: MODEL,
      isDirectUserSession: true,
      toolNames: Object.keys(tools),
      appCatalog: appCatalogPrompt,
    });
    const sections = await promptSections('chat', { ask: true });
    out.push(await finish('1 chat (all tools)', system, sections, tools));
  }

  // 2. A spoken turn: the same tools, the voice layer, no question card.
  {
    const { tools } = await chatTools({ direct: true });
    const system = await SystemPromptBuilder.build({
      surface: 'chat',
      model: MODEL,
      isDirectUserSession: true,
      toolNames: Object.keys(tools),
      responseMode: 'voice',
    });
    const sections = await promptSections('chat', { voice: true });
    out.push(await finish('2 voice', system, sections, tools));
  }

  // 3. The shared Telegram bot: identity guard + channel prompt, no tools.
  {
    const guard = buildIdentityGuard();
    const channel = await loadPrompt('alia-telegram');
    out.push(
      await finish(
        '3 telegram',
        `${guard}\n\n---\n\n${channel}`,
        [
          ['identity guard', tokens(guard)],
          ['prompts/alia-telegram.md', tokens(channel)],
        ],
        {},
      ),
    );
  }

  // 4. A developer-key client. Its own editor tools belong to the client.
  for (const surface of ['codea', 'cowork'] as const) {
    const { tools } = await chatTools({ direct: false });
    const system = await SystemPromptBuilder.build({
      surface,
      model: MODEL,
      isDirectUserSession: false,
      toolNames: Object.keys(tools),
    });
    const sections = await promptSections(surface, {});
    out.push(await finish(`4 dev-key ${surface}`, system, sections, tools));
  }

  // 5. An autonomous agent run holding only `browser`.
  {
    const agent = {
      _id: 'agent1',
      name: 'Scout',
      tagline: 'Finds things',
      description: 'Researches the web.',
      archetype: 'general',
      capabilityGrants: ['browser'],
    } as unknown as HydratedAgent;
    const tools = buildRuntimeTools(
      {
        session: { id: 's1' },
        onComplete: () => undefined,
        todoManager: {},
        browserSession: {},
      } as never,
      readCapabilityGrants(agent.capabilityGrants),
    );
    const body = buildRunnerPrompt(agent, { maxSteps: 25 } as never);
    const guard = buildIdentityGuard({ agentName: agent.name });
    out.push(
      await finish(
        '5 agent run (browser only)',
        `${guard}\n\n---\n\n${body}`,
        [
          ['identity guard', tokens(guard)],
          ['runner prompt', tokens(body)],
        ],
        tools,
      ),
    );
  }

  return out;
}

export function formatReport(measures: ScenarioMeasure[]): string {
  const row = (name: string, a: string, b: string, n: string, c: string) =>
    name.padEnd(30) + a.padStart(8) + b.padStart(8) + n.padStart(4) + c.padStart(8);
  const lines = [row('scenario', 'system', 'tools', '#', 'total')];
  for (const m of measures) {
    lines.push(
      row(
        m.name,
        String(m.systemTokens),
        String(m.toolTokens),
        String(m.toolCount),
        String(m.total),
      ),
    );
  }
  for (const m of measures) {
    lines.push('', `-- ${m.name}: system sections`);
    for (const [n, t] of m.sections) lines.push(`   ${n.padEnd(34)}${String(t).padStart(6)}`);
    lines.push(`   ${'(whole assembled message)'.padEnd(34)}${String(m.systemTokens).padStart(6)}`);
  }
  const chat = measures[0];
  if (chat) {
    lines.push('', '-- 1 chat: tools by size');
    for (const [n, t] of chat.perTool) lines.push(`   ${n.padEnd(34)}${String(t).padStart(6)}`);
  }
  return lines.join('\n');
}
