import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { inArray, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TEST_CHARACTER } from './support/agent-character';
import { closePostgres, connectPostgres, type ApiDatabase } from '../index';
import { agents } from '../schema/agents';
import { isGatedFeature, MAX_STARTER_TITLE_LENGTH } from '../../domain/agent-features';

/**
 * Migration 0101 turns the two former product agents into ordinary agents and
 * moves what the retired lane supplied from outside Alia — their prompts, gates
 * and starters — into their rows (ADR 0020 §8). It ran against an empty table
 * when this database was built, so it is replayed here over rows shaped like
 * production's, by id, and what it wrote is read back through the schema.
 */

const SINDI = '01a0646a-078f-7514-9800-9f43ceed7df8';
const CLARITY = '01a0646a-078f-7642-95ef-439952f4f3f9';
const MIGRATION = fileURLToPath(
  new URL('../../../drizzle/0101_app_agents_are_ordinary_agents.sql', import.meta.url),
);

let db: ApiDatabase;

/** Every key is one of Alia's gated features, and every gate names an app and a feature. */
function isGatesShape(gates: Record<string, unknown>): boolean {
  return Object.entries(gates).every(
    ([key, gate]) =>
      isGatedFeature(key) &&
      typeof (gate as { app?: unknown }).app === 'string' &&
      typeof (gate as { feature?: unknown }).feature === 'string',
  );
}

beforeAll(async () => {
  const connected = connectPostgres(process.env.DATABASE_URL);
  if (!connected) throw new Error('DATABASE_URL is not set; vitest.pg.globalSetup.ts must run.');
  db = connected;
  await db.delete(agents).where(inArray(agents.id, [SINDI, CLARITY]));
  for (const [id, account] of [
    [SINDI, 'sindi-bot-0101'],
    [CLARITY, 'clarity-bot-0101'],
  ] as const) {
    await db.insert(agents).values({
      id,
      oxyAccountId: account,
      ownerOxyAccountId: 'project-0101',
      character: TEST_CHARACTER,
      tagline: 'an app agent',
      description: 'before 0101',
      authorOxyUserId: 'project-0101',
      category: 'assistant',
      capabilityGrants: ['web', 'memory'],
      isPublished: false,
      access: 'private',
    });
  }
  for (const statement of readFileSync(MIGRATION, 'utf8').split('--> statement-breakpoint')) {
    await db.execute(sql.raw(statement));
  }
});

afterAll(async () => {
  await db.delete(agents).where(inArray(agents.id, [SINDI, CLARITY]));
  await closePostgres();
});

async function row(id: string) {
  const [found] = await db
    .select()
    .from(agents)
    .where(inArray(agents.id, [id]));
  if (!found) throw new Error(`no agent ${id}`);
  return found;
}

describe('0101: Sindi is an ordinary, listed agent with its own prompt, gates and starters', () => {
  it('is public and published, and keeps its families', async () => {
    const sindi = await row(SINDI);
    expect(sindi.access).toBe('public');
    expect(sindi.isPublished).toBe(true);
    expect(sindi.capabilityGrants).toEqual(['web', 'memory']);
  });

  it('carries the persona Homiio used to send, exactly', async () => {
    const { systemPrompt } = await row(SINDI);
    expect(systemPrompt?.startsWith("You are Sindi, Homiio's housing assistant")).toBe(true);
    expect(systemPrompt?.endsWith('Keep answers short unless asked for detail.')).toBe(true);
  });

  it("gates attachments behind Homiio's sindi.files, in the column's shape", async () => {
    const { featureGates } = await row(SINDI);
    expect(featureGates).toEqual({
      'attachments.documents': { app: 'homiio', feature: 'sindi.files' },
      'attachments.images': { app: 'homiio', feature: 'sindi.files' },
    });
    expect(isGatesShape(featureGates)).toBe(true);
  });

  it('offers three starters the editor would accept', async () => {
    const { starters } = await row(SINDI);
    for (const starter of starters) {
      expect(starter.title.length).toBeGreaterThan(0);
      expect(starter.title.length).toBeLessThanOrEqual(MAX_STARTER_TITLE_LENGTH);
    }
    expect(starters.map((starter) => starter.prompt)).toEqual([
      'Busca pisos en Gràcia por menos de 1.200 €',
      '¿Qué derechos tengo si me suben el alquiler?',
      'Revisa mi contrato de alquiler',
    ]);
  });
});

describe("0101: Clarity's assistant is public, unlisted, with Clarity's prompt and plan gates", () => {
  it('is public and not listed: Oxy confines it to Clarity', async () => {
    const clarity = await row(CLARITY);
    expect(clarity.access).toBe('public');
    expect(clarity.isPublished).toBe(false);
    expect(clarity.capabilityGrants).toEqual(['web', 'memory']);
  });

  it('carries the prompt that replaces prompts/base.md', async () => {
    const { systemPrompt } = await row(CLARITY);
    expect(systemPrompt?.startsWith('# Clarity\n\n## Identity')).toBe(true);
    expect(systemPrompt).toContain("You are **Clarity**, Oxy's search engine");
  });

  it("gates deep research and the gateable levels behind Clarity's plan features", async () => {
    const { featureGates } = await row(CLARITY);
    expect(featureGates).toEqual({
      deep_research: { app: 'clarity', feature: 'deep_research' },
      'power_level.pro': { app: 'clarity', feature: 'power_level.pro' },
      'power_level.ultra': { app: 'clarity', feature: 'power_level.ultra' },
    });
    expect(isGatesShape(featureGates)).toBe(true);
  });
});
