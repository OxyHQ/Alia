-- oxy:deploy-phase=post
--
-- Alia's own memory store, retired: what she remembers about a person is Nilo's `memories`
-- database (`oxy_nilo_memories__*`, docs/memory-system.md). The owner chose to delete the old
-- data rather than migrate it; nothing is exported or copied first.
--
-- Post phase: the image this rollout ships reads and writes none of it (`/memory` serves only
-- the profile's settings and style), and the image it replaces must be gone before the rows
-- disappear. `user_memories` stays: the answer preferences, the toggles and the writing style.
-- No CASCADE: `user_memory_entries` is the only table with a foreign key to `user_memories`, and
-- it goes first.
DROP TABLE "memory_embeddings";--> statement-breakpoint
DROP TABLE "user_memory_entries";--> statement-breakpoint
ALTER TABLE "user_memories" DROP COLUMN "preferences_interests";--> statement-breakpoint
ALTER TABLE "user_memories" DROP COLUMN "context_occupation";--> statement-breakpoint
ALTER TABLE "user_memories" DROP COLUMN "context_location";--> statement-breakpoint
ALTER TABLE "user_memories" DROP COLUMN "context_timezone";--> statement-breakpoint
ALTER TABLE "user_memories" DROP COLUMN "context_bio";
