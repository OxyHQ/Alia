-- oxy:deploy-phase=pre
--
-- ADR 0020 §8: there is no product-agent lane, so the two agents it bound
-- become ordinary agents BEFORE 0102 drops `agents.application_id`.
--
-- Sindi (Homiio) is public and listed. Clarity's assistant is public and NOT
-- listed: it is confined to Clarity by Oxy's application registry (Oxy ADR
-- 0044, Alia ADR 0021), so the catalogue must not offer it elsewhere.
--
-- Matched by exact id, never by name or handle. Their families
-- (`capability_grants`) are kept as they are.
--
-- PRE, because both images read these rows correctly: the image being
-- replaced still checks `application_id` first, so `access` changes nothing
-- for it, and the image being rolled out ignores `application_id` and needs
-- `access = 'public'` to open them. Either agent missing is a no-op.
UPDATE "agents"
SET "access" = 'public', "is_published" = true, "updated_at" = now()
WHERE "id" = '01a0646a-078f-7514-9800-9f43ceed7df8';--> statement-breakpoint
UPDATE "agents"
SET "access" = 'public', "is_published" = false, "updated_at" = now()
WHERE "id" = '01a0646a-078f-7642-95ef-439952f4f3f9';
