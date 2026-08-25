-- oxy:deploy-phase=pre
-- WIDENS two CHECK constraints; it narrows nothing and drops no data.
--
-- `pre` because it is safe while the PREVIOUS image is still serving: that
-- image cannot write `v1-image` — its own tuple has thirteen values — so the
-- widened constraint changes nothing for it. What it changes is that the
-- ARRIVING image stops having its image-model rows rejected.
--
-- The reverse phase would be wrong in the way that matters: `post` withholds
-- the constraint until after the new image is live, so every seed that image
-- runs on startup fails first — which is the exact symptom this migration
-- exists to end.
--
-- The drop-then-add is one statement pair inside one migration; there is no
-- window in which a row could be written that the re-added constraint would
-- refuse, because the new set is a strict superset of the old.

ALTER TABLE "alia_models" DROP CONSTRAINT "alia_models_tier_check";--> statement-breakpoint
ALTER TABLE "model_configs" DROP CONSTRAINT "model_configs_alia_tier_check";--> statement-breakpoint
ALTER TABLE "alia_models" ADD CONSTRAINT "alia_models_tier_check" CHECK ("alia_models"."tier" in ('lite', 'v1', 'v1-codea', 'v1-cowork', 'v1-browser', 'v1-vision', 'v1-audio', 'v1-tts', 'v1-image', 'v1-multimodal', 'v1-pro', 'v1-pro-max', 'v1-voice', 'v1-voice-pro'));--> statement-breakpoint
ALTER TABLE "model_configs" ADD CONSTRAINT "model_configs_alia_tier_check" CHECK ("model_configs"."alia_tier" in ('lite', 'v1', 'v1-codea', 'v1-cowork', 'v1-browser', 'v1-vision', 'v1-audio', 'v1-tts', 'v1-image', 'v1-multimodal', 'v1-pro', 'v1-pro-max', 'v1-voice', 'v1-voice-pro'));