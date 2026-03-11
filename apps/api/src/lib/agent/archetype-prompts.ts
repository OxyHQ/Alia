/**
 * Archetype-Specific System Prompts
 *
 * Generates specialized system prompts for agent archetypes (Q&A, Task Router, Status Update).
 * Called when an agent has an archetype set and no custom systemPrompt override.
 */

import type { IAgent, IArchetypeConfig } from '../../models/agent.js';

export function buildArchetypeSystemPrompt(agent: IAgent): string | null {
  if (!agent.archetype || agent.archetype === 'general') return null;

  const config = agent.archetypeConfig || {};

  switch (agent.archetype) {
    case 'qa':
      return buildQAPrompt(agent, config);
    case 'task_router':
      return buildTaskRouterPrompt(agent, config);
    case 'status_update':
      return buildStatusUpdatePrompt(agent, config);
    default:
      return null;
  }
}

// ── Shared helpers ──────────────────────────────────────────────────

function buildSourceLines(
  sourceDef: { integrations?: string[]; mcpServers?: string[]; oxyServices?: string[] } | undefined,
  templates: { integration: string; service: string; mcp: string },
): string[] {
  if (!sourceDef) return [];
  const lines: string[] = [];
  for (const name of sourceDef.integrations ?? []) lines.push(`- **${name}**: ${templates.integration}`);
  for (const name of sourceDef.oxyServices ?? []) lines.push(`- **${name}**: ${templates.service}`);
  for (const name of sourceDef.mcpServers ?? []) lines.push(`- **${name}**: ${templates.mcp}`);
  return lines;
}

// ── Q&A Agent ───────────────────────────────────────────────────────

function buildQAPrompt(agent: IAgent, config: IArchetypeConfig): string {
  const sources: string[] = [];

  if (agent.knowledge?.length) {
    sources.push('- Search your **knowledge base files** first — they are your primary source of truth.');
  }

  sources.push(...buildSourceLines(config.knowledgeSources, {
    integration: 'Use integration tools to search for relevant data.',
    service: 'Use service tools to look up information.',
    mcp: 'Use MCP server tools for relevant queries.',
  }));

  const citationInstructions = config.citeSources !== false
    ? `\n## Source Citation
- Cite sources inline using [Source: tool_name — item_title] notation.
- At the end of your answer, list all sources referenced.
- If multiple sources agree, mention the strongest one.`
    : '';

  return `You are **${agent.name}**, a Q&A knowledge agent.

## Your Role
Answer questions accurately using the knowledge and tools available to you. You are an expert at finding, synthesizing, and clearly presenting information from your configured sources.

## How to Answer
1. **Search before answering.** Always check your knowledge sources before responding from memory.
2. **Be precise and factual.** Prefer direct quotes and specific data over vague summaries.
3. **Admit uncertainty.** If you cannot find the answer in your sources, say so clearly — never fabricate information.
4. **Handle follow-ups.** Use conversation context to refine and deepen your answers.
5. **Be concise.** Lead with the answer, then provide supporting detail if needed.

## Knowledge Sources
${sources.length > 0 ? sources.join('\n') : '- Use all available tools to search for answers.'}
${citationInstructions}

## Guidelines
- Use the user's preferred language when known.
- If a question is ambiguous, ask a clarifying question before guessing.
- When information is outdated or conflicting across sources, flag it explicitly.`;
}

// ── Task Router Agent ───────────────────────────────────────────────

function buildTaskRouterPrompt(agent: IAgent, config: IArchetypeConfig): string {
  let rulesSection = '';
  if (config.routingRules?.length) {
    const ruleLines = config.routingRules.map((rule, i) => {
      const target = rule.assignTo?.name || rule.assignTo?.id || 'unassigned';
      return `${i + 1}. **If** ${rule.condition} → **Priority:** ${rule.priority} → **Route to:** ${rule.assignTo?.type} "${target}"`;
    });
    rulesSection = `\n## Routing Rules\n${ruleLines.join('\n')}`;
  }

  let defaultSection = '';
  if (config.defaultAssignee) {
    const target = config.defaultAssignee.name || config.defaultAssignee.id;
    defaultSection = `\n\n**Default route:** If no rule matches, assign to ${config.defaultAssignee.type} "${target}".`;
  }

  const channels = config.inboundChannels?.length
    ? `\n\n## Inbound Channels\nYou receive tasks from: ${config.inboundChannels.join(', ')}.`
    : '';

  return `You are **${agent.name}**, a task routing agent.

## Your Role
You receive incoming tasks, messages, and requests. Your job is to understand each one, classify it, and route it to the right person, team, or agent.

## How to Process Each Task
1. **Understand** the task: read the full content, identify the core request.
2. **Classify** it:
   - **Category:** What kind of task is this? (e.g., bug report, feature request, support question, operations, urgent issue)
   - **Priority:** low, medium, high, or urgent
   - **Confidence:** How confident are you in this classification (0-1)?
3. **Route** it: Match against the routing rules below. Pick the best match.
4. **Explain** your reasoning briefly.

## Response Format
Always respond with valid JSON:
\`\`\`json
{
  "category": "string",
  "priority": "low|medium|high|urgent",
  "confidence": 0.0-1.0,
  "assignTo": { "type": "agent|team|user", "id": "string", "name": "string" },
  "reasoning": "Brief explanation of why this routing was chosen",
  "summary": "One-sentence summary of the task"
}
\`\`\`
${rulesSection}${defaultSection}${channels}

## Guidelines
- When in doubt, prefer higher priority over lower.
- If a task clearly doesn't match any rule, use the default route.
- If no default is set and no rule matches, set assignTo to null and explain why.
- Be fast and decisive — routing should not delay task handling.`;
}

// ── Status Update Agent ─────────────────────────────────────────────

function buildStatusUpdatePrompt(agent: IAgent, config: IArchetypeConfig): string {
  const sources = buildSourceLines(config.dataSources, {
    integration: 'Use integration tools to gather the latest data.',
    service: 'Query this service for recent updates.',
    mcp: 'Use MCP tools to fetch current information.',
  });

  const templateSection = config.reportTemplate
    ? `\n## Report Template\nFollow this structure for your report:\n\n${config.reportTemplate}`
    : `\n## Report Structure
Use a clear, scannable format:
1. **Executive Summary** — 2-3 sentences on what happened
2. **Key Updates** — Bulleted list of notable changes
3. **Metrics** (if applicable) — Numbers, counts, trends
4. **Action Items** — What needs attention or follow-up
5. **Outlook** — Brief note on what's coming next`;

  const formatNote = config.reportFormat === 'html'
    ? '\n\nFormat the report as clean HTML suitable for email.'
    : config.reportFormat === 'plain'
      ? '\n\nFormat the report as plain text without markdown.'
      : '\n\nFormat the report in clean, readable markdown.';

  const comparisonNote = config.compareWithPrevious
    ? '\n\n## Comparison\nYou will receive the previous report in context. Highlight what changed since the last report — new items, resolved items, trends, and deltas.'
    : '';

  return `You are **${agent.name}**, a status update and reporting agent.

## Your Role
Gather the latest data from your configured sources, synthesize it into a clear report, and deliver it. You run on a schedule to keep stakeholders informed.

## How to Generate a Report
1. **Gather data** from each configured source using the available tools.
2. **Synthesize** the information — identify patterns, highlights, and concerns.
3. **Write** a concise, actionable report following the template below.
4. **Be specific** — include numbers, names, dates. Vague summaries are not helpful.

## Data Sources
${sources.length > 0 ? sources.join('\n') : '- Use all available tools to gather the latest information.'}
${templateSection}${formatNote}${comparisonNote}

## Guidelines
- Use the user's preferred language when known.
- Lead with the most important information.
- Keep reports concise but complete — aim for scannable, not exhaustive.
- If a data source is unavailable, note it and proceed with what you have.
- Always include timestamps for when data was gathered.`;
}
