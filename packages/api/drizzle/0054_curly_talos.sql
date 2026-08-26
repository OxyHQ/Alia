-- oxy:deploy-phase=post
--
-- Agent Skills, part two of two: the narrowing and the drops.
--
-- `0053` added the new shape beside the old one and backfilled it. This runs
-- once the new image is live and takes the old columns away, which is why it is
-- `post`: the image serving BEFORE that point still selects `title`, `tagline`
-- and `system_prompt`, and would answer 500 for every skill request the moment
-- they disappeared.
--
-- ## The backfill runs again, first
--
-- Between `0053` and this file there is a window in which the old image is
-- still accepting `POST /skills`, and a row it writes has no `name`, no
-- `display_name` and no `source` — the columns this file is about to mark NOT
-- NULL. Repeating the backfill for exactly those rows is what stops a deploy
-- from aborting on a skill somebody happened to create during the rollout. It
-- is scoped by `WHERE name IS NULL`, so on a database with no stragglers it
-- touches nothing.
--
-- A straggler's name is suffixed from its id rather than by `row_number()`: the
-- names `0053` already assigned are taken, and a second independent numbering
-- would not know about them.

-- ---------------------------------------------------------------------------
-- Stragglers written by the old image between the two phases
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION pg_temp.alia_uuid_v7() RETURNS text AS $$
  SELECT lpad(to_hex((extract(epoch from clock_timestamp()) * 1000)::bigint), 12, '0')
      || '7' || substr(md5(random()::text || clock_timestamp()::text), 1, 3)
      || substr('89ab', 1 + floor(random() * 4)::int, 1)
      || substr(md5(random()::text || clock_timestamp()::text), 1, 3)
      || substr(md5(random()::text || clock_timestamp()::text), 1, 12)
$$ LANGUAGE sql VOLATILE;
--> statement-breakpoint
WITH normalised AS (
  SELECT
    id,
    nullif(regexp_replace(left(regexp_replace(regexp_replace(lower(skill_id), '[^a-z0-9]+', '-', 'g'), '(^-+|-+$)', '', 'g'), 56), '-+$', ''), '') AS base
  FROM skills
  WHERE name IS NULL
)
UPDATE skills s
SET name = CASE
  WHEN NOT EXISTS (SELECT 1 FROM skills t WHERE t.name = coalesce(n.base, 'skill')
                     AND coalesce(t.owner_oxy_user_id, '') = coalesce(s.oxy_user_id, ''))
    THEN coalesce(n.base, 'skill')
  ELSE left(coalesce(n.base, 'skill'), 56) || '-' || substr(s.id, 1, 6)
END
FROM normalised n
WHERE s.id = n.id AND s.name IS NULL;
--> statement-breakpoint
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
  tags = ARRAY[category],
  icon = nullif(icon, ''),
  color = nullif(color, '')
WHERE display_name IS NULL;
--> statement-breakpoint
INSERT INTO skill_versions (id, skill_id, version, body, frontmatter, checksum, bytes, file_count, created_by_oxy_user_id, created_at)
SELECT
  pg_temp.alia_uuid_v7(), s.id, 1, s.system_prompt,
  jsonb_build_object('name', s.name, 'description', s.description),
  encode(sha256(convert_to(s.system_prompt, 'UTF8')), 'hex'),
  octet_length(s.system_prompt), 0, s.oxy_user_id, s.created_at
FROM skills s
WHERE NOT EXISTS (SELECT 1 FROM skill_versions v WHERE v.skill_id = s.id);
--> statement-breakpoint
INSERT INTO skill_installs (id, oxy_user_id, skill_id, enabled, auto_invoke, created_at, updated_at)
SELECT pg_temp.alia_uuid_v7(), s.oxy_user_id, s.id, true, true, s.created_at, s.updated_at
FROM skills s
WHERE s.oxy_user_id IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM skill_installs i WHERE i.skill_id = s.id AND i.oxy_user_id = s.oxy_user_id);
--> statement-breakpoint
UPDATE chat_analytics SET skill_names = ARRAY[skill_id] WHERE skill_id IS NOT NULL AND cardinality(skill_names) = 0;
--> statement-breakpoint
ALTER TABLE "skills" DROP CONSTRAINT "skills_category_check";--> statement-breakpoint
DROP INDEX "skills_skill_id_key";--> statement-breakpoint
DROP INDEX "skills_language_idx";--> statement-breakpoint
DROP INDEX "skills_is_published_idx";--> statement-breakpoint
DROP INDEX "skills_oxy_user_id_idx";--> statement-breakpoint
ALTER TABLE "skills" ALTER COLUMN "name" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "skills" ALTER COLUMN "display_name" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "skills" ALTER COLUMN "source" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "skills" ALTER COLUMN "visibility" SET NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "skills_owner_name_key" ON "skills" USING btree (coalesce("owner_oxy_user_id", ''),"name");--> statement-breakpoint
ALTER TABLE "skills" DROP COLUMN "skill_id";--> statement-breakpoint
ALTER TABLE "skills" DROP COLUMN "title";--> statement-breakpoint
ALTER TABLE "skills" DROP COLUMN "tagline";--> statement-breakpoint
ALTER TABLE "skills" DROP COLUMN "system_prompt";--> statement-breakpoint
ALTER TABLE "skills" DROP COLUMN "author";--> statement-breakpoint
ALTER TABLE "skills" DROP COLUMN "category";--> statement-breakpoint
ALTER TABLE "skills" DROP COLUMN "language";--> statement-breakpoint
ALTER TABLE "skills" DROP COLUMN "triggers";--> statement-breakpoint
ALTER TABLE "skills" DROP COLUMN "includes";--> statement-breakpoint
ALTER TABLE "skills" DROP COLUMN "use_case";--> statement-breakpoint
ALTER TABLE "skills" DROP COLUMN "good_at";--> statement-breakpoint
ALTER TABLE "skills" DROP COLUMN "not_good_at";--> statement-breakpoint
ALTER TABLE "skills" DROP COLUMN "is_built_in";--> statement-breakpoint
ALTER TABLE "skills" DROP COLUMN "is_published";--> statement-breakpoint
ALTER TABLE "skills" DROP COLUMN "oxy_user_id";--> statement-breakpoint
ALTER TABLE "chat_analytics" DROP COLUMN "skill_id";--> statement-breakpoint
ALTER TABLE "skills" ADD CONSTRAINT "skills_source_check" CHECK ("skills"."source" in ('builtin', 'registry', 'github', 'upload', 'authored'));--> statement-breakpoint
ALTER TABLE "skills" ADD CONSTRAINT "skills_visibility_check" CHECK ("skills"."visibility" in ('private', 'public'));--> statement-breakpoint
ALTER TABLE "skills" ADD CONSTRAINT "skills_name_format_check" CHECK ("skills"."name" ~ '^[a-z0-9]+(-[a-z0-9]+)*$' and length("skills"."name") <= 64);--> statement-breakpoint
ALTER TABLE "skills" ADD CONSTRAINT "skills_description_length_check" CHECK (length("skills"."description") between 1 and 1024);--> statement-breakpoint
ALTER TABLE "skills" ADD CONSTRAINT "skills_compatibility_length_check" CHECK ("skills"."compatibility" is null or length("skills"."compatibility") between 1 and 500);--> statement-breakpoint
ALTER TABLE "skills" ADD CONSTRAINT "skills_import_provenance_check" CHECK ("skills"."source" not in ('registry', 'github') or "skills"."source_repo" is not null);