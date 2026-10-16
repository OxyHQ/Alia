-- oxy:deploy-phase=post
--
-- ADR 0020 §8: the product-agent lane is gone and no image reads this column.
-- 0101 turned the two agents it bound into ordinary agents first.
DROP INDEX "agents_application_id_idx";--> statement-breakpoint
ALTER TABLE "agents" DROP COLUMN "application_id";
