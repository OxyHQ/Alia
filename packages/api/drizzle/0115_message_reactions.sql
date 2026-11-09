-- oxy:deploy-phase=pre
--
-- The emoji a person leaves under a message ("reactions", as a chat bubble shows them): a JSON array
-- of strings (`domain/message-reactions.ts`), NULL when there are none. Additive: the old image
-- never reads or writes the column.
--
-- LOCKS: `messages` is a hot table. ADD COLUMN of a nullable column with no default is a catalogue
-- change only (no table rewrite, no scan), and takes ACCESS EXCLUSIVE for the instant it needs.
ALTER TABLE "messages" ADD COLUMN "reactions" jsonb;
