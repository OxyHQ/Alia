-- oxy:deploy-phase=pre
--
-- An agent has a look: a Bloom avatar character, chosen in the agent editor and drawn everywhere an
-- agent appears (`domain/agent-character.ts`). It replaces "the Alia mark in the account's colour".
--
-- Pre phase, so ADDITIVE: the image this rollout replaces still creates agents without a look, so
-- the column is added nullable and filled here, and made NOT NULL by `0091_agent_character_required`
-- (post phase) once only the new image is serving. No code reads a "legacy" shape. Each existing
-- agent gets a shape and a paint spread over the plain set by its id
-- (stable, so a re-run of the backfill would pick the same), plain oval eyes and nothing on its head;
-- its owner changes it in the editor. The two lists are `PICKABLE_SHAPES` (18) and `PICKABLE_COLORS`
-- (9) of the domain module.
ALTER TABLE "agents" ADD COLUMN "character" jsonb;--> statement-breakpoint
UPDATE "agents" SET "character" = jsonb_build_object(
  'shape', (ARRAY[
    'rounded_triangle', 'capsule', 'rounded_head_two_ears', 'six_lobed_flower', 'heart',
    'four_lobed_butterfly', 'circle_two_ears', 'twelve_scalloped_rosette', 'rounded_cube',
    'rounded_diamond', 'slender', 'pocket', 'petal', 'star', 'cloud', 'shield', 'pebble', 'squircle'
  ])[1 + (abs(hashtext("id")::bigint) % 18)::int],
  'eyes', 'oval',
  'eyewear', 'none',
  'accessory', 'none',
  'color', (ARRAY[
    'pink', 'orchid', 'violet', 'blue', 'cyan', 'teal', 'lime', 'yellow', 'coral'
  ])[1 + ((abs(hashtext("id")::bigint) / 18) % 9)::int]
);
