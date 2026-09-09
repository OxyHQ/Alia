-- oxy:deploy-phase=post
--
-- Replace every persisted routing name in one transaction after the new image
-- is healthy. The retired spellings are assembled from fragments so they can
-- never be copied back into application code or documentation by search.
CREATE TEMP TABLE "_routing_name_cut" (
  "old_id" text PRIMARY KEY,
  "new_id" text NOT NULL
) ON COMMIT DROP;--> statement-breakpoint

INSERT INTO "_routing_name_cut" ("old_id", "new_id") VALUES
  (concat('kaana', '-lite'), 'route:instant'),
  (concat('kaana', '-v1'), 'route:auto'),
  (concat('kaana', '-v1-codea'), 'route:code'),
  (concat('kaana', '-v1-cowork'), 'route:cowork'),
  (concat('kaana', '-v1-browser'), 'route:research'),
  (concat('kaana', '-v1-vision'), 'route:vision'),
  (concat('kaana', '-v1-audio'), 'route:audio'),
  (concat('kaana', '-v1-multimodal'), 'route:multimodal'),
  (concat('kaana', '-v1-pro'), 'route:pro-standard'),
  (concat('kaana', '-v1-thinking'), 'route:thinking'),
  (concat('kaana', '-v1-pro-max'), 'route:pro'),
  (concat('kaana', '-v1-voice'), 'route:voice'),
  (concat('kaana', '-v1-voice-pro'), 'route:voice-pro'),
  (concat('alia', '-lite'), 'route:instant'),
  (concat('alia', '-v1'), 'route:auto'),
  (concat('alia', '-v1-codea'), 'route:code'),
  (concat('alia', '-v1-cowork'), 'route:cowork'),
  (concat('alia', '-v1-browser'), 'route:research'),
  (concat('alia', '-v1-vision'), 'route:vision'),
  (concat('alia', '-v1-audio'), 'route:audio'),
  (concat('alia', '-v1-multimodal'), 'route:multimodal'),
  (concat('alia', '-v1-pro'), 'route:pro-standard'),
  (concat('alia', '-v1-thinking'), 'route:thinking'),
  (concat('alia', '-v1-pro-max'), 'route:pro'),
  (concat('alia', '-v1-voice'), 'route:voice'),
  (concat('alia', '-v1-voice-pro'), 'route:voice-pro');--> statement-breakpoint

-- A new task may seed the clean row before this post-deploy migration runs.
-- Merge that overlap by stable database PK, keeping one child mapping per
-- provider model and preserving accumulated counters.
UPDATE "routing_profiles" AS target
SET "total_requests" = target."total_requests" + source."total_requests",
    "total_tokens" = target."total_tokens" + source."total_tokens"
FROM "routing_profiles" AS source
JOIN "_routing_name_cut" AS names ON names."old_id" = source."routing_profile_id"
WHERE target."routing_profile_id" = names."new_id"
  AND target."id" <> source."id";--> statement-breakpoint

DELETE FROM "routing_profile_provider_mappings" AS old_mapping
USING "routing_profiles" AS source, "routing_profiles" AS target, "_routing_name_cut" AS names
WHERE source."routing_profile_id" = names."old_id"
  AND target."routing_profile_id" = names."new_id"
  AND old_mapping."routing_profile_id" = source."id"
  AND EXISTS (
    SELECT 1
    FROM "routing_profile_provider_mappings" AS current_mapping
    WHERE current_mapping."routing_profile_id" = target."id"
      AND current_mapping."model_config_id" = old_mapping."model_config_id"
  );--> statement-breakpoint

UPDATE "routing_profile_provider_mappings" AS mapping
SET "routing_profile_id" = target."id"
FROM "routing_profiles" AS source, "routing_profiles" AS target, "_routing_name_cut" AS names
WHERE source."routing_profile_id" = names."old_id"
  AND target."routing_profile_id" = names."new_id"
  AND mapping."routing_profile_id" = source."id";--> statement-breakpoint

DELETE FROM "routing_profiles" AS source
USING "routing_profiles" AS target, "_routing_name_cut" AS names
WHERE source."routing_profile_id" = names."old_id"
  AND target."routing_profile_id" = names."new_id"
  AND source."id" <> target."id";--> statement-breakpoint

UPDATE "routing_profiles" AS p
SET "routing_profile_id" = m."new_id",
    "display_name" = CASE m."new_id"
      WHEN 'route:auto' THEN 'Auto'
      WHEN 'route:instant' THEN 'Instant'
      WHEN 'route:thinking' THEN 'Thinking'
      WHEN 'route:pro' THEN 'Pro'
      WHEN 'route:research' THEN 'Research'
      WHEN 'route:code' THEN 'Code'
      ELSE p."display_name"
    END
FROM "_routing_name_cut" AS m
WHERE p."routing_profile_id" = m."old_id";--> statement-breakpoint

UPDATE "routing_profiles" AS p
SET "replacement_model_id" = m."new_id"
FROM "_routing_name_cut" AS m
WHERE p."replacement_model_id" = m."old_id";--> statement-breakpoint

UPDATE "plans" AS p
SET "model_ids" = (
  SELECT array_agg(COALESCE(m."new_id", item) ORDER BY ord)
  FROM unnest(p."model_ids") WITH ORDINALITY AS valueset(item, ord)
  LEFT JOIN "_routing_name_cut" AS m ON m."old_id" = item
);--> statement-breakpoint

UPDATE "agents" AS a
SET "allowed_models" = (
  SELECT array_agg(COALESCE(m."new_id", item) ORDER BY ord)
  FROM unnest(a."allowed_models") WITH ORDINALITY AS valueset(item, ord)
  LEFT JOIN "_routing_name_cut" AS m ON m."old_id" = item
);--> statement-breakpoint

UPDATE "fallback_events" AS e SET "routing_profile" = m."new_id"
FROM "_routing_name_cut" AS m WHERE e."routing_profile" = m."old_id";--> statement-breakpoint
UPDATE "chat_analytics" AS e SET "routing_profile_id" = m."new_id"
FROM "_routing_name_cut" AS m WHERE e."routing_profile_id" = m."old_id";--> statement-breakpoint
UPDATE "cost_entries" AS e SET "routing_profile_id" = m."new_id"
FROM "_routing_name_cut" AS m WHERE e."routing_profile_id" = m."old_id";--> statement-breakpoint
UPDATE "voice_call_usage" AS e SET "routing_profile_id" = m."new_id"
FROM "_routing_name_cut" AS m WHERE e."routing_profile_id" = m."old_id";--> statement-breakpoint

ALTER TABLE "agents" ALTER COLUMN "allowed_models" SET DEFAULT '{"route:auto","route:pro-standard"}';
