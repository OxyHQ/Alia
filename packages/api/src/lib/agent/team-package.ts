/*
 * Validation approach adapted from OpenMausBot server/team-manifest.ts at
 * 0a17fa5759e7b77ce4c3a0326109ca342da9c260. Apache-2.0.
 * Modified for Alia bot accounts, Agent Skills and channel templates.
 */
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { z } from 'zod';

export const ALIA_TEAM_FORMAT = 'alia.team' as const;
export const ALIA_TEAM_VERSION = 1 as const;
export const MAX_TEAM_MEMBERS = 50;
export const MAX_TEAM_CHANNELS = 50;

const identifier = z.string().trim().min(1).max(64).regex(/^[a-z0-9][a-z0-9_-]*$/);
const member = z.object({
  key: identifier,
  name: z.string().trim().min(1).max(100),
  tagline: z.string().trim().max(200).default(''),
  instructions: z.string().max(24_000).default(''),
  skills: z.array(z.string().trim().min(1).max(128)).max(50).default([]),
}).strict();
const channel = z.object({
  key: identifier,
  name: z.string().trim().min(1).max(100),
  instructions: z.string().max(12_000).default(''),
  responder: z.union([z.literal('coordinator'), z.literal('everyone'), z.literal('mentions'), identifier]),
}).strict();
const packageSchema = z.object({
  format: z.literal(ALIA_TEAM_FORMAT),
  version: z.literal(ALIA_TEAM_VERSION),
  name: z.string().trim().min(1).max(100),
  description: z.string().trim().max(2_000).default(''),
  coordinator: identifier,
  members: z.array(member).min(1).max(MAX_TEAM_MEMBERS),
  channels: z.array(channel).max(MAX_TEAM_CHANNELS).default([]),
  automations: z.array(z.object({
    name: z.string().trim().min(1).max(100),
    prompt: z.string().trim().min(1).max(12_000),
  }).strict()).max(50).default([]),
}).strict();

export type AliaTeamPackage = z.infer<typeof packageSchema>;

function uniqueKeys(values: Array<{ key: string }>, label: string): void {
  const keys = new Set<string>();
  for (const value of values) {
    if (keys.has(value.key)) throw new Error(`Duplicate ${label} key: ${value.key}`);
    keys.add(value.key);
  }
}

/** Parse an untrusted portable definition. Privilege-bearing fields are rejected by strict schemas. */
export function parseAliaTeamPackage(input: unknown): AliaTeamPackage {
  const parsed = packageSchema.parse(input);
  uniqueKeys(parsed.members, 'member');
  uniqueKeys(parsed.channels, 'channel');
  const members = new Set(parsed.members.map((item) => item.key));
  if (!members.has(parsed.coordinator)) throw new Error(`Unknown coordinator: ${parsed.coordinator}`);
  for (const item of parsed.channels) {
    if (!['coordinator', 'everyone', 'mentions'].includes(item.responder) && !members.has(item.responder)) {
      throw new Error(`Unknown channel responder: ${item.responder}`);
    }
  }
  return parsed;
}

export function parseAliaTeamMarkdown(markdown: string): { manifest: AliaTeamPackage; playbook: string } {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)([\s\S]*)$/.exec(markdown);
  if (!match) throw new Error('Team package requires YAML frontmatter');
  return { manifest: parseAliaTeamPackage(parseYaml(match[1]!)), playbook: match[2]!.trim() };
}

export function serializeAliaTeamMarkdown(manifest: AliaTeamPackage, playbook = ''): string {
  const safe = parseAliaTeamPackage(manifest);
  return `---\n${stringifyYaml(safe).trim()}\n---\n${playbook.trim()}\n`;
}
