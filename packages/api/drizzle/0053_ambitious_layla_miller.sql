-- oxy:deploy-phase=pre
--
-- Agent Skills, part one of two: everything additive.
--
-- A skill stops being one row of prose and becomes a versioned directory
-- conforming to <https://agentskills.io>. Three new tables carry what a
-- directory holds — the immutable version, its bundled files, and who installed
-- it — and `skills` grows the spec's own fields beside the ones it already had.
--
-- Nothing the running image reads is removed here. `0054` drops the old columns
-- once the new image is live; this file only adds, and then backfills so that
-- the drop has nothing left to take.
--
-- Two statements widen rather than add: `icon` and `color` lose their NOT NULL,
-- because an imported skill carries neither. The image serving today always
-- writes both, so a wider column is invisible to it.
--
-- `chat_analytics.skill_names` arrives beside `skill_id` for the same reason: a
-- turn can now activate several skills, and the old image still writes the old
-- column until it stops serving.

CREATE TABLE "skill_files" (
	"id" text PRIMARY KEY NOT NULL,
	"version_id" text NOT NULL,
	"path" text NOT NULL,
	"kind" text NOT NULL,
	"mime" text NOT NULL,
	"bytes" integer NOT NULL,
	"sha256" text NOT NULL,
	"content_text" text,
	"s3_key" text,
	"executable" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "skill_files_kind_check" CHECK ("skill_files"."kind" in ('reference', 'script', 'asset')),
	CONSTRAINT "skill_files_storage_check" CHECK (("skill_files"."content_text" is null) <> ("skill_files"."s3_key" is null)),
	CONSTRAINT "skill_files_path_safety_check" CHECK (left("skill_files"."path", 1) <> '/' and strpos("skill_files"."path", '..') = 0 and strpos("skill_files"."path", chr(92)) = 0),
	CONSTRAINT "skill_files_bytes_check" CHECK ("skill_files"."bytes" >= 0)
);
--> statement-breakpoint
CREATE TABLE "skill_installs" (
	"id" text PRIMARY KEY NOT NULL,
	"oxy_user_id" text NOT NULL,
	"skill_id" text NOT NULL,
	"pinned_version" integer,
	"enabled" boolean DEFAULT true NOT NULL,
	"auto_invoke" boolean DEFAULT true NOT NULL,
	"last_used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "skill_installs_pinned_version_check" CHECK ("skill_installs"."pinned_version" is null or "skill_installs"."pinned_version" >= 1)
);
--> statement-breakpoint
CREATE TABLE "skill_versions" (
	"id" text PRIMARY KEY NOT NULL,
	"skill_id" text NOT NULL,
	"version" integer NOT NULL,
	"body" text NOT NULL,
	"frontmatter" jsonb NOT NULL,
	"source_commit" text,
	"checksum" text NOT NULL,
	"bytes" integer NOT NULL,
	"file_count" integer DEFAULT 0 NOT NULL,
	"created_by_oxy_user_id" text,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "skill_versions_version_check" CHECK ("skill_versions"."version" >= 1),
	CONSTRAINT "skill_versions_bytes_check" CHECK ("skill_versions"."bytes" >= 0),
	CONSTRAINT "skill_versions_file_count_check" CHECK ("skill_versions"."file_count" >= 0)
);
--> statement-breakpoint
ALTER TABLE "skills" ALTER COLUMN "icon" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "skills" ALTER COLUMN "color" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "skills" ADD COLUMN "name" text;--> statement-breakpoint
ALTER TABLE "skills" ADD COLUMN "display_name" text;--> statement-breakpoint
ALTER TABLE "skills" ADD COLUMN "license" text;--> statement-breakpoint
ALTER TABLE "skills" ADD COLUMN "compatibility" text;--> statement-breakpoint
ALTER TABLE "skills" ADD COLUMN "allowed_tools" text[] DEFAULT '{}' NOT NULL;--> statement-breakpoint
ALTER TABLE "skills" ADD COLUMN "spec_metadata" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "skills" ADD COLUMN "source" text;--> statement-breakpoint
ALTER TABLE "skills" ADD COLUMN "source_repo" text;--> statement-breakpoint
ALTER TABLE "skills" ADD COLUMN "source_path" text;--> statement-breakpoint
ALTER TABLE "skills" ADD COLUMN "source_url" text;--> statement-breakpoint
ALTER TABLE "skills" ADD COLUMN "publisher" text;--> statement-breakpoint
ALTER TABLE "skills" ADD COLUMN "tags" text[] DEFAULT '{}' NOT NULL;--> statement-breakpoint
ALTER TABLE "skills" ADD COLUMN "owner_oxy_user_id" text;--> statement-breakpoint
ALTER TABLE "skills" ADD COLUMN "visibility" text DEFAULT 'private';--> statement-breakpoint
ALTER TABLE "skills" ADD COLUMN "install_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "chat_analytics" ADD COLUMN "skill_names" text[] DEFAULT '{}' NOT NULL;--> statement-breakpoint
ALTER TABLE "skill_files" ADD CONSTRAINT "skill_files_version_id_fk" FOREIGN KEY ("version_id") REFERENCES "public"."skill_versions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "skill_installs" ADD CONSTRAINT "skill_installs_skill_id_fk" FOREIGN KEY ("skill_id") REFERENCES "public"."skills"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "skill_versions" ADD CONSTRAINT "skill_versions_skill_id_fk" FOREIGN KEY ("skill_id") REFERENCES "public"."skills"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "skill_files_version_path_key" ON "skill_files" USING btree ("version_id","path");--> statement-breakpoint
CREATE UNIQUE INDEX "skill_installs_user_skill_key" ON "skill_installs" USING btree ("oxy_user_id","skill_id");--> statement-breakpoint
CREATE INDEX "skill_installs_user_enabled_idx" ON "skill_installs" USING btree ("oxy_user_id","enabled");--> statement-breakpoint
CREATE UNIQUE INDEX "skill_versions_skill_version_key" ON "skill_versions" USING btree ("skill_id","version");--> statement-breakpoint
CREATE INDEX "skill_versions_skill_created_at_idx" ON "skill_versions" USING btree ("skill_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "skills_visibility_idx" ON "skills" USING btree ("visibility");--> statement-breakpoint
CREATE INDEX "skills_source_idx" ON "skills" USING btree ("source");--> statement-breakpoint
CREATE INDEX "skills_owner_oxy_user_id_idx" ON "skills" USING btree ("owner_oxy_user_id");
--> statement-breakpoint
-- ---------------------------------------------------------------------------
-- Backfill
-- ---------------------------------------------------------------------------
--
-- Ids are uuid v7 in this schema — `@oxyhq/db`'s `generatedId` generates them in
-- the application because Postgres 17 has no `uuidv7()`. A backfill has no
-- application to ask, and `gen_random_uuid()` would write v4s that
-- `isLiveEntityId` rejects at API boundaries, so the shape is composed here:
-- 48-bit millisecond timestamp, version nibble 7, RFC 9562 variant. The function
-- lives in `pg_temp`, so it exists for this migration's session and no longer.
--
-- OR REPLACE, because a genesis run (`--phase=all`, which every `*.pgdb` suite
-- performs) applies this file and `0054` over ONE session, and `pg_temp` is
-- per-session: a plain CREATE would find the function already there and die.
CREATE OR REPLACE FUNCTION pg_temp.alia_uuid_v7() RETURNS text AS $$
  SELECT lpad(to_hex((extract(epoch from clock_timestamp()) * 1000)::bigint), 12, '0')
      || '7' || substr(md5(random()::text || clock_timestamp()::text), 1, 3)
      || substr('89ab', 1 + floor(random() * 4)::int, 1)
      || substr(md5(random()::text || clock_timestamp()::text), 1, 3)
      || substr(md5(random()::text || clock_timestamp()::text), 1, 12)
$$ LANGUAGE sql VOLATILE;
--> statement-breakpoint
-- `skill_id` was a slug derived from a title and is very nearly a spec `name`
-- already, but not quite: it was never normalised at the ends, so a title that
-- ended in punctuation could leave a trailing hyphen the spec forbids. The
-- normalisation can also collide two rows onto one name, which the unique index
-- `0054` adds would then refuse — so the number is assigned by `row_number()`
-- within the namespace rather than hoped for.
WITH normalised AS (
  SELECT
    id,
    coalesce(oxy_user_id, '') AS namespace,
    -- Truncated to 56 so the collision suffix cannot push the name past the
    -- spec's 64, and re-trimmed afterwards because a cut can land on a hyphen.
    nullif(regexp_replace(left(regexp_replace(regexp_replace(lower(skill_id), '[^a-z0-9]+', '-', 'g'), '(^-+|-+$)', '', 'g'), 56), '-+$', ''), '') AS base,
    created_at
  FROM skills
),
ranked AS (
  SELECT
    id,
    coalesce(base, 'skill') AS base,
    row_number() OVER (PARTITION BY namespace, coalesce(base, 'skill') ORDER BY created_at, id) AS rn
  FROM normalised
)
UPDATE skills s
SET name = CASE WHEN r.rn = 1 THEN r.base ELSE r.base || '-' || r.rn END
FROM ranked r
WHERE s.id = r.id AND s.name IS NULL;
--> statement-breakpoint
-- `tagline` and `description` were two fields for one job. The spec has one
-- `description`, and it must say what the skill does AND when to use it, so the
-- two are joined and `use_case` follows them — that is the sentence a model
-- matches a request against. `left(…, 1024)` is the spec's limit, enforced as a
-- CHECK in `0054`.
--
-- `title` was NOT NULL and could still be the empty string: the editor autosaved
-- whatever was in the field, including nothing. So could the three description
-- fields, which is why each fallback here ends somewhere non-empty — `0054` adds
-- a CHECK that a zero-length description would fail.
UPDATE skills
SET
  display_name = coalesce(nullif(btrim(title), ''), name),
  description = left(coalesce(
    nullif(btrim(concat_ws(' ', nullif(btrim(tagline), ''), nullif(btrim(description), ''), nullif(btrim(use_case), ''))), ''),
    nullif(btrim(title), ''),
    'Imported from a skill written before Alia adopted the Agent Skills format.'
  ), 1024),
  source = CASE WHEN is_built_in THEN 'builtin' ELSE 'authored' END,
  publisher = author,
  owner_oxy_user_id = oxy_user_id,
  visibility = CASE WHEN is_built_in OR is_published THEN 'public' ELSE 'private' END,
  -- The three categories were UI shelves rather than a taxonomy. They survive as
  -- tags, where a shelf is what they always were, instead of as a closed set the
  -- new model has no use for.
  tags = ARRAY[category],
  icon = nullif(icon, ''),
  color = nullif(color, '')
WHERE display_name IS NULL;
--> statement-breakpoint
-- Every skill gets version 1, whose body is the prompt it used to be. This is
-- the whole of the old feature's content, so after this statement the old
-- columns hold nothing that is not also held here — which is what makes `0054`
-- a drop rather than a deletion.
INSERT INTO skill_versions (id, skill_id, version, body, frontmatter, checksum, bytes, file_count, created_by_oxy_user_id, created_at)
SELECT
  pg_temp.alia_uuid_v7(),
  s.id,
  1,
  s.system_prompt,
  jsonb_build_object('name', s.name, 'description', s.description),
  encode(sha256(convert_to(s.system_prompt, 'UTF8')), 'hex'),
  octet_length(s.system_prompt),
  0,
  s.oxy_user_id,
  s.created_at
FROM skills s
WHERE NOT EXISTS (SELECT 1 FROM skill_versions v WHERE v.skill_id = s.id);
--> statement-breakpoint
-- A person who wrote a skill has it on their shelf. Nobody is given anybody
-- else's: installing is explicit from here on, and inventing installs for the
-- catalogue would put third-party instructions in front of accounts that never
-- asked for them.
INSERT INTO skill_installs (id, oxy_user_id, skill_id, enabled, auto_invoke, created_at, updated_at)
SELECT pg_temp.alia_uuid_v7(), s.oxy_user_id, s.id, true, true, s.created_at, s.updated_at
FROM skills s
WHERE s.oxy_user_id IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM skill_installs i WHERE i.skill_id = s.id AND i.oxy_user_id = s.oxy_user_id);
--> statement-breakpoint
-- Analytics keeps its history: one recorded skill becomes a one-element set.
UPDATE chat_analytics SET skill_names = ARRAY[skill_id] WHERE skill_id IS NOT NULL AND cardinality(skill_names) = 0;
