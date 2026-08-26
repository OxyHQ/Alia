/**
 * The prompt text that describes an AGENT to the model.
 *
 * Two things live here: the archetype prompts (Q&A, task router, status update)
 * and {@link agentRemitPrompt}, the one answer to "what describes this agent",
 * which the archetypes are one branch of.
 */

import { readArchetypeConfig, type ArchetypeConfig } from '../../domain/agent.js';
import { agentPromptName, type HydratedAgent } from '../agent-identity.js';
import { agentSectionHeading } from '../identity-guard.js';

/**
 * What this agent is for, in the words its owner gave. NEVER empty.
 *
 * ## Four surfaces asked this question and four answered it differently
 *
 * `system-prompt-builder.ts` and `voice.ts` asked `systemPrompt ?? archetype`
 * and injected NOTHING when both were absent — which is every agent created
 * through `POST /agents` without a prompt, since `archetype` defaults to
 * `general` and `buildArchetypeSystemPrompt` returns null for it. The identity
 * guard above still said "You are Claudio", so the model was given a name and
 * no remit at all: the reported "responde de todo", exactly.
 *
 * `webhooks.ts` asked `systemPrompt` alone and fell back to the generic Alia
 * channel prompt, so the same agent answering its own Telegram bot was handed
 * somebody else's description. `runner.ts` was the only one with a real
 * fallback, and it built it inline.
 *
 * One function, so the four cannot drift again.
 *
 * ## The fallback is the listing, and the listing always exists
 *
 * `tagline` and `description` are `NOT NULL` and `POST /agents` requires
 * `min(1)` on both, so the last branch can always be reached and can never
 * produce an empty string. That is what lets the return type be `string` rather
 * than `string | null` — a caller that has an agent always has something to say
 * about it.
 *
 * It describes and never names: `You are ${name}` belongs to the identity guard
 * and used to be duplicated here, which is the same two-owners defect one layer
 * down.
 *
 * ## The HEADER is part of it, and that is what the guard points at
 *
 * `buildIdentityGuard`'s remit rule names this section — "the section headed
 * `# AGENT: <name>`" — rather than saying "everything below", because
 * everything below is not all one thing. A trigger's composition has the
 * agent's description AND the trigger's own task under the guard, and "the
 * task in front of you" is not a redefinition of what the agent is for. The
 * loose wording read the task as the remit, measurably: on the trigger path the
 * only thing under the guard WAS the task.
 *
 * So the header is emitted here, once, instead of being written out at each
 * composition site. The guard's reference and the header it refers to are then
 * two halves of one fact in one repository, and
 * `__tests__/agent-turn-system-prompt.test.ts` asserts the reference resolves
 * to a real header in the composed message rather than to nothing.
 */
export function agentRemitPrompt(agent: HydratedAgent): string {
  return `${agentSectionHeading(agentPromptName(agent))}\n\n${remitBody(agent)}`;
}

function remitBody(agent: HydratedAgent): string {
  const own = agent.systemPrompt?.trim();
  if (own) return own;

  const archetype = buildArchetypeSystemPrompt(agent)?.trim();
  if (archetype) return archetype;

  return `${agent.tagline}\n\n${agent.description}`;
}

export function buildArchetypeSystemPrompt(agent: HydratedAgent): string | null {
  if (agent.archetype === 'general') return null;

  const config = readArchetypeConfig(agent.archetypeConfig);

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

/**
 * ## `knowledgeSources` and `dataSources` are gone from both prompts
 *
 * They were the THIRD parallel vocabulary for "what may this agent touch" —
 * three string lists naming integrations, MCP servers and Oxy services inside
 * `archetype_config`, rendered into these two prompts as prose bullets. They
 * decided nothing: the tools were in the set or not regardless, and the lists
 * named sources the agent might never have been able to reach.
 *
 * Nothing replaces the bullets, because the tool set already carries the
 * answer: every MCP, integration and Oxy-service tool is described to the model
 * with the connector's own display name, and `getOxyServicePromptFragment`
 * already names the services in the prompt. Saying it a third time in prose
 * assembled from a different source is how the three disagreed.
 */

// ── Q&A Agent ───────────────────────────────────────────────────────

function buildQAPrompt(agent: HydratedAgent, config: ArchetypeConfig): string {
  const sources: string[] = [];

  if (agent.knowledge?.length) {
    sources.push('- Search your **knowledge base files** first — they are your primary source of truth.');
  }

  const citationInstructions = config.citeSources !== false
    ? `\n## Source Citation
- Cite sources inline using [Source: tool_name — item_title] notation.
- At the end of your answer, list all sources referenced.
- If multiple sources agree, mention the strongest one.`
    : '';

  return `You are **${agentPromptName(agent)}**, a Q&A knowledge agent.

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

function buildTaskRouterPrompt(agent: HydratedAgent, config: ArchetypeConfig): string {
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

  return `You are **${agentPromptName(agent)}**, a task routing agent.

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

function buildStatusUpdatePrompt(agent: HydratedAgent, config: ArchetypeConfig): string {
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

  return `You are **${agentPromptName(agent)}**, a status update and reporting agent.

## Your Role
Gather the latest data from your configured sources, synthesize it into a clear report, and deliver it. You run on a schedule to keep stakeholders informed.

## How to Generate a Report
1. **Gather data** from each configured source using the available tools.
2. **Synthesize** the information — identify patterns, highlights, and concerns.
3. **Write** a concise, actionable report following the template below.
4. **Be specific** — include numbers, names, dates. Vague summaries are not helpful.

## Data Sources
- Use all available tools to gather the latest information.
${templateSection}${formatNote}${comparisonNote}

## Guidelines
- Use the user's preferred language when known.
- Lead with the most important information.
- Keep reports concise but complete — aim for scannable, not exhaustive.
- If a data source is unavailable, note it and proceed with what you have.
- Always include timestamps for when data was gathered.`;
}
