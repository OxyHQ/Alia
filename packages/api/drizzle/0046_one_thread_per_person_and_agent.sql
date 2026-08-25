-- oxy:deploy-phase=post
-- The index this file was named for is GONE, and only the lossless cleanup is
-- left. Read this header before the rest, which still argues for a constraint
-- that no longer exists here.
--
-- ## The model changed, and then this could not apply
--
-- `/a/:username` is NOT one thread per (person, agent). It is one continuous
-- view over MANY conversations sharing an `agent_id` — because what the model
-- is given as context is the ACTIVE conversation, not the whole thread, so
-- starting a new stretch is what keeps that context bounded. 0048 states it at
-- length. A UNIQUE index forbids exactly that.
--
-- So the index had to go, and there were two ways to get there. The one not
-- taken: leave it here, let 0048 drop it a moment later. Rehearsed against a
-- database carrying production's actual rows, that DOES NOT WORK — two
-- conversations with real history make this file fail, and 0048 sits BEHIND it
-- in the ledger, so the migration that removes the index can never run. The
-- deploy is stuck until somebody edits somebody else's conversations.
--
-- ## Why editing an already-merged migration is legitimate HERE
--
-- It is the objection a reviewer should raise first, and the answer is three
-- facts rather than a preference:
--
--  - **The ledger records SUCCESSFUL applications.** Production never applied
--    this file: it failed on `CREATE UNIQUE INDEX` and the deploy rolled back.
--    So production will run the edited version, once, as its first attempt.
--  - **The databases that DID apply the original are CI's**, built from empty
--    on every run and discarded. They have no duplicate pairs, so the `UPDATE`
--    below was a no-op there and the index they created is dropped by 0048
--    regardless. No durable database diverges.
--  - **There is nowhere else to put it.** A new migration runs AFTER this one,
--    which is the one that fails. The only place a fix for this file can live
--    is inside it.
--
-- What remains below is the `UPDATE`, which is kept rather than deleted: it is
-- lossless, it was reviewed, and an agent-linked conversation with no messages
-- and no breaks is residue under the new model too — the `New chat` row that
-- `POST /conversations/new` minted on every visit.
--
-- ---- the original header follows, and its constraint no longer exists ----
--
-- `/a/:username` is ONE thread per (person, agent). This is what makes that
-- true rather than merely intended.
--
-- `post`, because it NARROWS: the image running before this deploy still
-- accepts an `agentId` on `POST /conversations/new`, so it can still create a
-- second row for a pair. Creating the unique index while that image is live is
-- how a working request starts answering 500 with a duplicate-key error.
--
-- ## It was rejected in production, and that is why the UPDATE below exists
--
-- This shipped asserting that a duplicate pair must fail the deploy, because a
-- silent dedupe picks a winner nobody chose. It then failed the deploy, and
-- looking at what it refused is what changed the design rather than the claim:
--
--   oxy_user 6981…8ffb, agent 01a038bd…, FIVE conversations, created between
--   12:48 and 14:11 on 2026-08-25. Four hold ZERO messages, no last_message,
--   and `updated_at` equal to `created_at`. One holds six messages.
--
-- Those four are not threads anybody had. They are the `New chat` row
-- `POST /conversations/new` mints on every VISIT to an agent — the exact
-- behaviour a permanent thread exists to end — and they accumulated in the
-- ninety minutes between the app's `/a/:username` shipping and this API half
-- landing. An empty conversation contains nothing to lose, so refusing the
-- whole rollout over it is refusing over residue.
--
-- So the rule is split, and only the provably-lossless half is automatic:
--
--  - **An agent-linked conversation with no messages and no breaks is
--    UNLINKED** (`agent_id = NULL`) when another conversation for the same pair
--    has content, or is newer among an all-empty set. Unlinked, not deleted:
--    the row survives as an ordinary empty conversation its owner can remove,
--    and this migration destroys nothing. Nothing else reads
--    `conversations.agent_id` on a turn — the agent is named by the REQUEST
--    (`lib/chat/request-context.ts`), so an unlinked conversation still opens
--    and still answers.
--  - **Two conversations with real content are still a REFUSAL.** The UPDATE
--    cannot touch either, `CREATE UNIQUE INDEX` fails, the deploy rolls back
--    with the task's logs, and somebody decides which history survives. That is
--    the case the original sentence was about, and it is preserved exactly.
--
-- The earlier census — 31 conversations, ONE with an `agent_id`, zero duplicate
-- pairs, with a positive control in the same query — was correct when it was
-- taken and had gone stale by the time this ran. That is the lesson worth more
-- than the number: a count taken before a feature ships is not a fact about the
-- database on the day it deploys.
--
-- ## Rehearsed against production's exact shape, and two cases it must refuse
--
-- Three throwaway databases, each built to the schema production actually had
-- (a genesis run of the migration folder as of 0118bfa6, then `--phase=pre`),
-- planted, then rolled forward with `--phase=post`:
--
--   five for one pair, four empty, one with six messages
--     -> APPLIED. Only the one with messages keeps its link; the four empties
--        are unlinked. Message count unchanged: nothing was deleted.
--   two conversations, both with messages
--     -> REFUSED. Both still linked, both messages intact, no index.
--   two conversations, the older carrying a BREAK and no messages
--     -> APPLIED. The one with the break survives.
--
-- The third case is why "content" is spelled the same way on both sides of the
-- comparison below. The first version guarded breaks but did not COUNT them,
-- so it refused a pair it could have resolved — found by rehearsing it, not by
-- reading it.
--
-- There is no permanent test for this UPDATE, deliberately. Exercising it needs
-- the unique index gone, and dropping an index inside a transaction takes an
-- ACCESS EXCLUSIVE lock on `conversations` in a pgdb suite whose files share
-- ONE database and run in parallel — a lock that reads as a flake in somebody
-- else's file. The INVARIANT is pinned instead, permanently, by
-- `db/__tests__/agentThread.pgdb.test.ts`; this statement is a one-shot that
-- was rehearsed.
--
-- The index it replaces covered the same pair and enforced nothing. PARTIAL on
-- `agent_id IS NOT NULL` so the ordinary conversations — all of them NULL
-- there — stay out of it entirely.

UPDATE "conversations" c
   SET "agent_id" = NULL
 WHERE c."agent_id" IS NOT NULL
   AND NOT EXISTS (
     SELECT 1 FROM "messages" m
      WHERE m."oxy_user_id" = c."oxy_user_id"
        AND m."conversation_id" = c."conversation_id"
   )
   AND NOT EXISTS (
     SELECT 1 FROM "conversation_breaks" b
      WHERE b."oxy_user_id" = c."oxy_user_id"
        AND b."conversation_id" = c."conversation_id"
   )
   AND EXISTS (
     SELECT 1 FROM "conversations" o
      WHERE o."oxy_user_id" = c."oxy_user_id"
        AND o."agent_id" = c."agent_id"
        AND o."id" <> c."id"
        AND (
          -- Another conversation for this pair holds content, so this empty
          -- one was never the thread. "Content" is spelled the SAME way on
          -- both sides of the comparison — a message OR a break — because a
          -- rule that guarded breaks but did not count them would refuse a
          -- pair it could have resolved.
          EXISTS (
            SELECT 1 FROM "messages" m2
             WHERE m2."oxy_user_id" = o."oxy_user_id"
               AND m2."conversation_id" = o."conversation_id"
          )
          OR EXISTS (
            SELECT 1 FROM "conversation_breaks" b2
             WHERE b2."oxy_user_id" = o."oxy_user_id"
               AND b2."conversation_id" = o."conversation_id"
          )
          -- Or every one of them is empty, in which case the newest survives.
          -- `id` breaks a same-millisecond tie so the winner is total rather
          -- than whatever the planner visited first.
          OR (o."created_at", o."id") > (c."created_at", c."id")
        )
   );--> statement-breakpoint
