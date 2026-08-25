-- oxy:deploy-phase=post
-- Alia stops storing an agent's identity. Oxy owns it.
--
-- `post`, and unambiguously: the previous image reads `name`, `handle` and
-- `avatar` on every agent response, so these drops are only safe once it is
-- gone. `0035` added the replacement in the `pre` phase, which is what makes
-- this an expand-then-contract rather than a break — and see `0035` for why the
-- two cannot be merged into one file.
--
-- Nothing is lost. The census in `0035` measured `agents` at ZERO rows in
-- production on 2026-08-25, with a positive control, so every column below is
-- empty everywhere it exists.
--
-- Three of them were not Oxy's and go for their own reasons:
--   * `is_verified` and `last_scheduled_check` were ORPHANS — zero writers and
--     zero readers, present only in the record mapper.
--   * `credit_balance` was written and displayed but NEVER SPENT. A bot account
--     is an Oxy account, so it has a real `user_credits` row of its own.
--
-- `agents_handle_key` goes with `handle`. What replaces it is not an index here
-- at all: `User.username` is unique across the whole Oxy account graph, which
-- is a wider guarantee than this table could ever make.

DROP INDEX "agents_handle_key";--> statement-breakpoint
ALTER TABLE "agents" DROP COLUMN "name";--> statement-breakpoint
ALTER TABLE "agents" DROP COLUMN "handle";--> statement-breakpoint
ALTER TABLE "agents" DROP COLUMN "avatar";--> statement-breakpoint
ALTER TABLE "agents" DROP COLUMN "author_name";--> statement-breakpoint
ALTER TABLE "agents" DROP COLUMN "author_verified";--> statement-breakpoint
ALTER TABLE "agents" DROP COLUMN "is_verified";--> statement-breakpoint
ALTER TABLE "agents" DROP COLUMN "credit_balance";--> statement-breakpoint
ALTER TABLE "agents" DROP COLUMN "last_scheduled_check";