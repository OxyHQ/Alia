import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import {
  constraintNameOf,
  isCheckViolation,
  isForeignKeyViolation,
  isUniqueViolation,
} from '@oxyhq/db';
import { closePostgres, connectPostgres, type ApiDatabase } from '../index';
import { contextEdges, contextNodes, contextSources } from '../schema/context-graph';
import { CONTEXT_EDGE_TYPES } from '../../value-sets/context-edge.js';

/**
 * The context graph, against a REAL server.
 *
 * The referential integrity below is the ONLY thing in this batch that Mongo
 * could not express at all, so it is the only thing whose port is a genuine
 * behaviour change rather than a translation — and none of it has a mocked
 * counterpart.
 */

let db: ApiDatabase;

beforeAll(() => {
  const connected = connectPostgres(process.env.DATABASE_URL);
  if (!connected) throw new Error('DATABASE_URL is not set; vitest.pg.globalSetup.ts must run.');
  db = connected;
});

afterAll(async () => {
  await closePostgres();
});

const insertNode = (id: string, nodeKey: string, oxyUserId = 'ctx-user') => db.execute(sql`
  insert into ${contextNodes} (id, oxy_user_id, node_key, type, label, last_seen_at)
  values (${id}, ${oxyUserId}, ${nodeKey}, 'memory', ${nodeKey}, now())
`);

const insertEdge = (id: string, from: string, to: string, oxyUserId = 'ctx-user', edgeType = 'related_to') => db.execute(sql`
  insert into ${contextEdges} (id, oxy_user_id, from_node_id, to_node_id, edge_type, last_seen_at)
  values (${id}, ${oxyUserId}, ${from}, ${to}, ${edgeType}, now())
`);

describe('an edge cannot outlive either of its endpoints', () => {
  it('refuses an edge pointing at a node that does not exist', async () => {
    await insertNode('ctx-n-real', 'real');

    /**
     * Mongo stored `fromNodeId`/`toNodeId` as bare ObjectIds with a `ref` it
     * never enforced, so this insert simply succeeded there and produced an
     * edge nothing could traverse. This is the tightening, and it is the one a
     * backfill can trip on.
     */
    await expect(insertEdge('ctx-e-dangling', 'ctx-n-real', 'ctx-n-missing')).rejects.toSatisfy(
      (error: unknown) => {
        expect(isForeignKeyViolation(error)).toBe(true);
        expect(constraintNameOf(error)).toBe('context_edges_to_node_id_context_nodes_id_fk');
        return true;
      },
    );
  });

  it('deletes an edge with its endpoint, and leaves unrelated edges alone', async () => {
    await insertNode('ctx-a', 'a');
    await insertNode('ctx-b', 'b');
    await insertNode('ctx-c', 'c');
    await insertNode('ctx-d', 'd');
    await insertEdge('ctx-e-ab', 'ctx-a', 'ctx-b');
    await insertEdge('ctx-e-cd', 'ctx-c', 'ctx-d');

    await db.execute(sql`delete from ${contextNodes} where id = 'ctx-a'`);

    const rows = await db.execute<{ id: string }>(
      sql`select id from ${contextEdges} where id in ('ctx-e-ab', 'ctx-e-cd') order by id`,
    );
    // Both halves matter: a cascade that took everything would satisfy "the
    // edge is gone" just as well as the correct one.
    expect(rows.map((r) => r.id)).toEqual(['ctx-e-cd']);
  });

  it('cascades from the TO endpoint as well as the FROM endpoint', async () => {
    await insertNode('ctx-x', 'x');
    await insertNode('ctx-y', 'y');
    await insertEdge('ctx-e-xy', 'ctx-x', 'ctx-y');

    // Two separate foreign keys, so one being right says nothing about the
    // other — deleting the TARGET is the direction a single-FK port would miss.
    await db.execute(sql`delete from ${contextNodes} where id = 'ctx-y'`);

    const rows = await db.execute<{ id: string }>(
      sql`select id from ${contextEdges} where id = 'ctx-e-xy'`,
    );
    expect(rows).toHaveLength(0);
  });
});

describe('the uniques that make a key a key', () => {
  it('refuses a second node for one (user, node_key)', async () => {
    await insertNode('ctx-u-1', 'duplicate-key');

    await expect(insertNode('ctx-u-2', 'duplicate-key')).rejects.toSatisfy((error: unknown) => {
      expect(isUniqueViolation(error)).toBe(true);
      expect(constraintNameOf(error)).toBe('context_nodes_oxy_user_node_key_key');
      return true;
    });
  });

  it('scopes that uniqueness to the user, so two people can hold the same key', async () => {
    /**
     * The fixture that makes a single-column unique and this compound one
     * disagree. `node_key` is derived from message TEXT
     * (`context-graph.ts:234`), so two users saying the same thing collide —
     * not a hypothetical.
     */
    await insertNode('ctx-shared-1', 'same-text', 'ctx-user-one');
    await insertNode('ctx-shared-2', 'same-text', 'ctx-user-two');

    const rows = await db.execute<{ n: string }>(
      sql`select count(*)::text as n from ${contextNodes} where node_key = 'same-text'`,
    );
    expect(rows[0]?.n).toBe('2');
  });

  it('refuses a second source for one (user, source_key)', async () => {
    const insertSource = (id: string) => db.execute(sql`
      insert into ${contextSources} (id, oxy_user_id, source_key, kind, label)
      values (${id}, 'ctx-user', 'calendar', 'calendar', 'Calendar')
    `);
    await insertSource('ctx-s-1');

    await expect(insertSource('ctx-s-2')).rejects.toSatisfy((error: unknown) => {
      expect(constraintNameOf(error)).toBe('context_sources_oxy_user_source_key_key');
      return true;
    });
  });
});

describe('the edge type CHECK reached the server', () => {
  it('refuses a type outside the tuple', async () => {
    await insertNode('ctx-t-1', 't1');
    await insertNode('ctx-t-2', 't2');

    await expect(
      insertEdge('ctx-e-badtype', 'ctx-t-1', 'ctx-t-2', 'ctx-user', 'befriends'),
    ).rejects.toSatisfy((error: unknown) => {
      expect(isCheckViolation(error)).toBe(true);
      expect(constraintNameOf(error)).toBe('context_edges_edge_type_check');
      return true;
    });
  });

  it('accepts every value that IS in the tuple, `references` included', async () => {
    await insertNode('ctx-all-from', 'all-from');
    await insertNode('ctx-all-to', 'all-to');

    // `references` is a SQL keyword; it is a plain string here, and running the
    // whole tuple is what proves the CHECK was rendered from the same source
    // that types the column rather than from a copy.
    for (const edgeType of CONTEXT_EDGE_TYPES) {
      await insertEdge(`ctx-e-${edgeType}`, 'ctx-all-from', 'ctx-all-to', 'ctx-all-user', edgeType);
    }

    const rows = await db.execute<{ n: string }>(
      sql`select count(*)::text as n from ${contextEdges} where oxy_user_id = 'ctx-all-user'`,
    );
    expect(rows[0]?.n).toBe(String(CONTEXT_EDGE_TYPES.length));
  });
});
