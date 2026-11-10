-- oxy:deploy-phase=pre
--
-- Spaces (ADR 0028): a folder that groups a person's agents. A new `spaces` table and one nullable
-- column on `agents` (`space_id`, the space an agent is in). Additive: the image being replaced never
-- reads either. The foreign key is added NOT VALID; the index on `agents` is 0125 and the validation
-- 0126, each its own transaction, so no lock on the hot table is held while rows are read.
--
-- ## LOCKS
--
-- CREATE TABLE and its two indexes touch no existing data. ADD COLUMN of a nullable column with no
-- default is a catalogue change on PostgreSQL 11+ (no rewrite, no scan). The foreign key is NOT VALID, so
-- it scans nothing and holds its locks for the instant it takes.
CREATE TABLE "spaces" (
	"id" text PRIMARY KEY NOT NULL,
	"oxy_user_id" text NOT NULL,
	"name" text NOT NULL,
	"instructions" text DEFAULT '' NOT NULL,
	"conversation_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL
);
--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "space_id" text;--> statement-breakpoint
CREATE INDEX "spaces_owner_idx" ON "spaces" USING btree ("oxy_user_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "spaces_conversation_key" ON "spaces" USING btree ("oxy_user_id","conversation_id");--> statement-breakpoint
ALTER TABLE "agents" ADD CONSTRAINT "agents_space_id_spaces_id_fk" FOREIGN KEY ("space_id") REFERENCES "public"."spaces"("id") ON DELETE set null ON UPDATE no action NOT VALID;