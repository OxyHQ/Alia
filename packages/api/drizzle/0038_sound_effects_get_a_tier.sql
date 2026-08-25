-- oxy:deploy-phase=pre
-- WIDENS two CHECK constraints so they admit `v1-sfx`. It narrows nothing and
-- drops no data.
--
-- `pre`, for the reason 0037 gives two migrations ago and for the same tier
-- column: `seedModelConfigs` runs on deploy and writes `model_configs.alia_tier`
-- for every tier in `TIER_MODEL_MAPPINGS`, so the constraint has to accept
-- `v1-sfx` BEFORE the image carrying the sound-effect mappings is serving.
-- `post` would withhold it until after that image is live, and every seed it
-- ran before then would refuse the two new rows — which is precisely the
-- failure 0037 exists to have ended.
--
-- Safe against the image still serving: its own tuple has fourteen values, so
-- it cannot write `v1-sfx` and the widened constraint changes nothing for it.
-- The new set is a strict superset of the old, so the drop-and-re-add pair
-- cannot fail on an existing row and there is no window in which one could be
-- written that the re-added constraint would refuse.
--
-- REGENERATED rather than renumbered after rebasing onto 0037. A snapshot
-- records the schema its migration leaves behind, so the file this replaces —
-- built on a tree without 0037 — would have produced a chain that reads as
-- ordered and is not, and a CHECK missing `v1-image`.

ALTER TABLE "alia_models" DROP CONSTRAINT "alia_models_tier_check";--> statement-breakpoint
ALTER TABLE "model_configs" DROP CONSTRAINT "model_configs_alia_tier_check";--> statement-breakpoint
ALTER TABLE "alia_models" ADD CONSTRAINT "alia_models_tier_check" CHECK ("alia_models"."tier" in ('lite', 'v1', 'v1-codea', 'v1-cowork', 'v1-browser', 'v1-vision', 'v1-audio', 'v1-tts', 'v1-sfx', 'v1-image', 'v1-multimodal', 'v1-pro', 'v1-pro-max', 'v1-voice', 'v1-voice-pro'));--> statement-breakpoint
ALTER TABLE "model_configs" ADD CONSTRAINT "model_configs_alia_tier_check" CHECK ("model_configs"."alia_tier" in ('lite', 'v1', 'v1-codea', 'v1-cowork', 'v1-browser', 'v1-vision', 'v1-audio', 'v1-tts', 'v1-sfx', 'v1-image', 'v1-multimodal', 'v1-pro', 'v1-pro-max', 'v1-voice', 'v1-voice-pro'));
