-- oxy:deploy-phase=post
--
-- Every agent has a look. `0089_agent_character` added the column nullable and filled it; this
-- makes it NOT NULL, and it is the post phase because the image the rollout replaced still created
-- agents without one: a NOT NULL ahead of the new image would have refused its inserts. Those rows
-- (written between the two) are filled the same way first, so the constraint finds nothing to refuse.
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
)
WHERE "character" IS NULL;--> statement-breakpoint
ALTER TABLE "agents" ALTER COLUMN "character" SET NOT NULL;
