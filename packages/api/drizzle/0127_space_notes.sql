-- oxy:deploy-phase=pre
--
-- A space's shared notes (ADR 0028): the memory every member of a space reads and keeps and the person
-- can edit. A new table only, so ADDITIVE: the image being replaced never reads it. The foreign key to
-- `spaces` is on a table that is created empty in this same migration.
--
-- ## LOCKS
--
-- CREATE TABLE and its index touch no existing data; the foreign key is validated against an empty table.
CREATE TABLE "space_memory_documents" (
	"id" text PRIMARY KEY NOT NULL,
	"space_id" text NOT NULL,
	"path" text NOT NULL,
	"content" text DEFAULT '' NOT NULL,
	"content_hash" text NOT NULL,
	"byte_length" integer DEFAULT 0 NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"last_editor" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL
);
--> statement-breakpoint
ALTER TABLE "space_memory_documents" ADD CONSTRAINT "space_memory_documents_space_id_spaces_id_fk" FOREIGN KEY ("space_id") REFERENCES "public"."spaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "space_memory_documents_space_path_key" ON "space_memory_documents" USING btree ("space_id","path");