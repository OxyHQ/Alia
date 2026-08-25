-- oxy:deploy-phase=post
-- Searching what was SAID in a thread — and only that.
--
-- ## `post` on a purely ADDITIVE migration, which is against the usual rule
--
-- Everything here is a new function and a new index. By the rule this journal
-- lives by that is `pre`, and it was `pre` — until the deploy that carried it
-- refused to run, in exactly the shape `.github/workflows/deploy-aws.yml`
-- describes as the reason a `migration_phase` input exists in other repos:
--
--   0047 is a pre-deploy migration queued behind the post-deploy migration
--   0046, which is not applied yet. Applying 0047 would require applying 0046
--   first — the ledger records progress as a high-water mark and cannot skip
--   one — and that would break the image currently serving.
--
-- The migrator offers three ways out and this is the only conservative one.
-- Making 0046 `pre` would put a UNIQUE index in front of the image that can
-- still insert a duplicate pair, which is the failure 0046 is `post` to avoid.
-- Running the whole journal with `all` does the same thing and more. Splitting
-- the release means reverting a merged feature to land it again unchanged.
--
-- **What `post` costs here, stated plainly:** between the new image starting
-- and this migration completing — minutes, and the deploy rolls the service
-- back if it fails — `GET /conversations/:id/search` and the `searchThread`
-- tool raise, because `alia_message_text` does not exist yet. Nothing else in
-- the service touches it, nothing reads it at boot, and both surfaces are new
-- in the same release. That is a strictly smaller blast radius than a unique
-- index arriving early.
--
-- `alia_message_text` is written by hand because drizzle-kit emits no
-- functions, and the index above it cannot exist without one: `content` is
-- `jsonb`, so a `tsvector` needs an EXPRESSION, and Postgres forbids a subquery
-- inside an index expression. A function is the only way to fold the parts
-- array into text.
--
-- IMMUTABLE is a promise, not a check, so it has to be true: the result depends
-- on the argument and on nothing else. `WITH ORDINALITY` plus the explicit
-- `ORDER BY` is what makes it true for an array — `string_agg` over an
-- unordered set is free to concatenate in any order, and an index built on an
-- expression that can answer differently for the same input is a corrupt index
-- rather than a slow one.
--
-- What it leaves out is the point: only `type: 'text'` parts, so tool payloads
-- (ids, URLs, field names from somebody else's API) and attachment metadata are
-- not searchable and cannot produce a hit on a message whose visible body does
-- not contain the query. `tool_invocations` is a separate column and is not
-- indexed at all.
--
-- The index is PARTIAL on the two roles a person searches, and uses the
-- `simple` configuration deliberately: a stemmer must be chosen per language,
-- this product is used in at least two, and `spanish` stems English badly.
-- `db/schema/chat.ts` carries the full argument.

CREATE FUNCTION alia_message_text(content jsonb) RETURNS text
  LANGUAGE sql
  IMMUTABLE
  PARALLEL SAFE
  STRICT
AS $$
  SELECT CASE jsonb_typeof(content)
    WHEN 'string' THEN content #>> '{}'
    WHEN 'array' THEN (
      SELECT string_agg(part.value ->> 'text', ' ' ORDER BY part.ordinality)
      FROM jsonb_array_elements(content) WITH ORDINALITY AS part(value, ordinality)
      WHERE part.value ->> 'type' = 'text'
        AND jsonb_typeof(part.value -> 'text') = 'string'
    )
    ELSE NULL
  END
$$;--> statement-breakpoint
CREATE INDEX "messages_search_idx" ON "messages" USING gin (to_tsvector('simple', alia_message_text("content"))) WHERE "messages"."role" in ('user', 'assistant');
