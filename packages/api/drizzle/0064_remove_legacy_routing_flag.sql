-- oxy:deploy-phase=post
-- Routing profiles are current or absent; the product no longer carries a
-- second, legacy catalogue class.
ALTER TABLE "routing_profiles" DROP COLUMN "is_legacy";
