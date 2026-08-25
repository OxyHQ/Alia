/**
 * Searching a thread, against a real server — because every property here is
 * the DATABASE's.
 *
 * `alia_message_text` is a Postgres function and the index is an expression
 * over it, so none of this is testable in JavaScript: what is findable is
 * decided by SQL, and a stub would assert the stub's opinion of it.
 *
 * ## The assertion this file exists for
 *
 * **A tool payload must not be findable.** It is JSON somebody else's API
 * returned — ids, URLs, field names — and a hit on one shows a person a message
 * whose visible body does not contain what they searched for. It is also the
 * failure that would never be noticed: a search that returns MORE than it
 * should looks like a search that works.
 *
 * Every account and conversation id is unique to its test: the pgdb suite shares
 * one database across every file in it.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { closePostgres, connectPostgres, type ApiDatabase } from '../index';
import { insertMessages, searchThread } from '../chat/messageRepository';
import type { MessageContent, MessageRole } from '../../domain/conversation';

let db: ApiDatabase;

const SUITE = `search-${process.pid}`;
const OWNER = `${SUITE}-owner`;
const THREAD = `${SUITE}-thread`;
const AGENT = `${SUITE}-agent`;

beforeAll(async () => {
  const connected = connectPostgres(process.env.DATABASE_URL);
  if (!connected) throw new Error('DATABASE_URL is not set; vitest.pg.globalSetup.ts must run.');
  db = connected;

  // A thread is a (person, agent) pair, so the conversations that make it up
  // have to exist and carry the agent — the search JOINS them.
  await db.execute(sql`
    insert into conversations (id, oxy_user_id, conversation_id, title, agent_id)
    values (${`${SUITE}-c1`}, ${OWNER}, ${THREAD}, 'thread', ${AGENT})
  `);

  await insertMessages(db, [
    {
      conversationId: THREAD,
      oxyUserId: OWNER,
      role: 'user',
      content: 'we decided to use kingfisher as the codename',
      seq: 0,
    },
    {
      conversationId: THREAD,
      oxyUserId: OWNER,
      role: 'assistant',
      content: [
        { type: 'text', text: 'Noted. Kingfisher it is, and the deadline is' },
        { type: 'text', text: 'the fourteenth of March.' },
      ] as MessageContent,
      seq: 1,
    },
    {
      /**
       * The trap. `heronwatch` appears ONLY inside a tool invocation and inside
       * a tool part of the content array — never in anything a person read.
       */
      conversationId: THREAD,
      oxyUserId: OWNER,
      role: 'assistant',
      content: [
        { type: 'text', text: 'I looked it up.' },
        { type: 'tool-webSearch', input: { q: 'heronwatch' }, output: { url: 'https://heronwatch.example' } },
        { type: 'file', filename: 'heronwatch-report.pdf', mediaType: 'application/pdf' },
      ] as MessageContent,
      toolInvocations: [
        { toolCallId: 't1', toolName: 'webSearch', state: 'result', result: { title: 'heronwatch' } },
      ],
      seq: 2,
    },
    {
      // A role a person does not search. Its text is unique so its exclusion is
      // observable rather than incidental.
      conversationId: THREAD,
      oxyUserId: OWNER,
      role: 'system' as MessageRole,
      content: 'you are a helpful assistant named cormorant',
      seq: 3,
    },
  ]);
});

afterAll(async () => {
  await closePostgres();
});

const found = (query: string) =>
  searchThread(db, { oxyUserId: OWNER, agentId: AGENT, query, limit: 20 });

describe('a thread is searchable by what was said', () => {
  it('finds a word the person typed', async () => {
    const hits = await found('codename');
    expect(hits.map((h: { role: string }) => h.role)).toEqual(['user']);
    expect(hits[0].text).toContain('kingfisher');
  });

  it('finds a word the assistant said, across parts', async () => {
    const hits = await found('deadline');
    expect(hits).toHaveLength(1);
    expect(hits[0].role).toBe('assistant');
    // The parts are joined IN ORDER, so a sentence split across two of them is
    // one string rather than two fragments in whatever order the array scanned.
    expect(hits[0].text).toBe('Noted. Kingfisher it is, and the deadline is the fourteenth of March.');
  });

  it('finds both sides of one exchange', async () => {
    const hits = await found('kingfisher');
    expect(hits.map((h: { role: string }) => h.role).sort()).toEqual(['assistant', 'user']);
  });
});

describe('what a search must NOT find', () => {
  it('does not find a word that only appears inside a tool payload', async () => {
    // The assertion this file exists for. `heronwatch` is in the tool part's
    // input, its output, the file name and `tool_invocations` — four places,
    // none of them anything a person read.
    expect(await found('heronwatch')).toEqual([]);
  });

  it('still finds the visible text of that same message', async () => {
    // The control. Without it, "no hit for heronwatch" is satisfied by a search
    // that cannot see that message at all — and then the exclusion above would
    // be measuring the wrong thing.
    const hits = await found('looked');
    expect(hits).toHaveLength(1);
    expect(hits[0].text).toBe('I looked it up.');
  });

  it('does not find a system prompt', async () => {
    expect(await found('cormorant')).toEqual([]);
  });

  it('does not reach into another person’s thread', async () => {
    await db.execute(sql`
      insert into conversations (id, oxy_user_id, conversation_id, title, agent_id)
      values (${`${SUITE}-c2`}, ${`${SUITE}-stranger`}, ${`${SUITE}-other-thread`}, 't', ${AGENT})
    `);
    await insertMessages(db, [
      {
        conversationId: `${SUITE}-other-thread`,
        oxyUserId: `${SUITE}-stranger`,
        role: 'user',
        content: 'the codename is nightjar',
        seq: 0,
      },
    ]);

    expect(await found('nightjar')).toEqual([]);
    // And the stranger's own search does find it, so the scoping is a filter
    // rather than the row being missing. Same AGENT, which is what makes this
    // a scoping assertion rather than two unrelated threads.
    const theirs = await searchThread(db, {
      oxyUserId: `${SUITE}-stranger`,
      agentId: AGENT,
      query: 'nightjar',
      limit: 20,
    });
    expect(theirs).toHaveLength(1);
  });

  it('does not cross into another person’s thread of the SAME name', async () => {
    /**
     * The leak the previous case cannot see, and it survives the move to a
     * thread-scoped search. `conversation_id` is unique only WITHIN a person,
     * so two accounts may hold the same one — and then a search filtered on the
     * conversation alone answers with somebody else's messages. Measured by
     * mutation: dropping `oxy_user_id` from the join leaves the case above
     * green and reds this one.
     */
    await db.execute(sql`
      insert into conversations (id, oxy_user_id, conversation_id, title, agent_id)
      values (${`${SUITE}-c3`}, ${`${SUITE}-namesake`}, ${THREAD}, 't', ${AGENT})
    `);
    await insertMessages(db, [
      {
        conversationId: THREAD,
        oxyUserId: `${SUITE}-namesake`,
        role: 'user',
        content: 'my private word is bittern',
        seq: 0,
      },
    ]);

    expect(await found('bittern')).toEqual([]);
    // The control: it really is there, under the same conversation id.
    expect(
      await searchThread(db, {
        oxyUserId: `${SUITE}-namesake`,
        agentId: AGENT,
        query: 'bittern',
        limit: 20,
      }),
    ).toHaveLength(1);
  });

  it('finds nothing for a query nobody wrote', async () => {
    expect(await found('flamingo')).toEqual([]);
  });
});

describe('the query is what somebody would type into a search box', () => {
  it('requires every word, the way a search box does', async () => {
    // MEASURED, not assumed: `websearch_to_tsquery` ANDs unquoted terms exactly
    // as `plainto_tsquery` does — what it adds is quoted phrases, `-`
    // exclusion, and never raising. So two words both present hit, and one word
    // that is absent takes the whole query with it.
    expect(await found('kingfisher codename')).toHaveLength(1);
    expect(await found('kingfisher flamingo')).toEqual([]);
  });

  it('finds nothing for a natural-language question, which is why the tool says so', async () => {
    // The consequence of the line above, pinned rather than left to be
    // discovered by a model typing a sentence: every word has to be in the
    // message. `lib/tools/thread-search.ts` tells the model this in its
    // description AND again in the message it returns for an empty result,
    // because a bare `[]` reads to a model as a broken tool.
    expect(await found('what was the codename again')).toEqual([]);
  });

  it('excludes a term with a leading minus', async () => {
    // The other half of what `websearch_to_tsquery` buys over `plainto_tsquery`.
    expect(await found('kingfisher')).toHaveLength(2);
    expect(await found('kingfisher -deadline')).toHaveLength(1);
  });

  it('takes a quoted phrase as a phrase', async () => {
    expect(await found('"the codename"')).toHaveLength(1);
    expect(await found('"codename the"')).toEqual([]);
  });

  it('does not raise on punctuation a person types', async () => {
    // `to_tsquery` THROWS on a stray operator, which is a 500 on an apostrophe.
    for (const query of ["what's the codename?", 'codename & ', '((', 'a | ']) {
      await expect(found(query)).resolves.toBeInstanceOf(Array);
    }
  });
});

describe('the function and the index are what the schema says', () => {
  it('extracts a bare string, an ordered parts array, and nothing else', async () => {
    const [row] = await db.execute<{
      plain: string | null;
      parts: string | null;
      object: string | null;
      empty: string | null;
    }>(sql`
      select alia_message_text('"just a string"'::jsonb) as plain,
             alia_message_text('[{"type":"text","text":"one"},
                                {"type":"tool-x","input":"two"},
                                {"type":"text","text":"three"}]'::jsonb) as parts,
             alia_message_text('{"type":"text","text":"four"}'::jsonb) as object,
             alia_message_text('[{"type":"tool-x","input":"five"}]'::jsonb) as empty
    `);

    expect(row.plain).toBe('just a string');
    expect(row.parts).toBe('one three');
    // An object is not a shape this column holds; answering NULL keeps it out
    // of the index rather than indexing its keys.
    expect(row.object).toBeNull();
    expect(row.empty).toBeNull();
  });

  it('is declared IMMUTABLE, which is what lets an index be built on it', async () => {
    // Not cosmetic: `CREATE INDEX` refuses a non-immutable expression outright,
    // so this is the property the migration depends on. Read from the catalogue
    // rather than from the migration text, which is what the database believes.
    const [row] = await db.execute<{ volatile: string }>(sql`
      select provolatile as volatile from pg_proc where proname = 'alia_message_text'
    `);
    expect(row.volatile).toBe('i');
  });

  it('built the partial index over the two searchable roles', async () => {
    const [row] = await db.execute<{ def: string }>(sql`
      select indexdef as def from pg_indexes where indexname = 'messages_search_idx'
    `);
    expect(row.def).toContain('gin');
    expect(row.def).toContain('alia_message_text');
    expect(row.def).toContain("'simple'");
    // The predicate, which is what keeps system and tool rows out of it — and
    // what the query has to spell identically to be able to use it.
    expect(row.def).toMatch(/WHERE .*role.*=.*ANY|WHERE .*role.*IN|WHERE .*'user'::text/);
  });
});
