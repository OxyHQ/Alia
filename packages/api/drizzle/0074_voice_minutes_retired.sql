-- oxy:deploy-phase=post
--
-- The voice-minutes allowance, retired with the metered voice session it
-- counted.
--
-- `voice_call_usage` was written only by the LiveKit voice route, which #477
-- reduced to a refusal and SDK 8.0.0 removed; since then nothing has
-- written it, so the allowance read "zero minutes used" for everyone and
-- enforced nothing. Voice now runs on the device and each spoken turn is an
-- ordinary chat turn and speech request, each billed per call through Oxy
-- (ADR 0005: allowances are consumed against Oxy-recorded usage, never against
-- a separate Alia count). The `voice-mode` capability stays.
--
-- Post phase: the image this rollout ships no longer seeds, reads or writes any
-- of it, and the image it replaces must be gone before the rows its
-- `GET /billing/voice-usage` read disappear. Nothing is read, exported or
-- copied first. No CASCADE: `plan_features` rows are deleted explicitly before
-- the feature their foreign key names.
DELETE FROM "plan_features" WHERE "feature_id" = 'voice-minutes';--> statement-breakpoint
DELETE FROM "features" WHERE "feature_id" = 'voice-minutes';--> statement-breakpoint
DROP TABLE "voice_call_usage";
