-- oxy:deploy-phase=post
LOCK TABLE organizations, organization_identity_archives, organization_members, organization_invites IN ACCESS EXCLUSIVE MODE;
--> statement-breakpoint
DO $$ BEGIN
 IF EXISTS (SELECT 1 FROM organizations WHERE oxy_account_id IS NULL OR btrim(oxy_account_id) = '') THEN
  RAISE EXCEPTION 'Organization cutover requires reviewed canonical mappings for every workspace';
 END IF;
 IF EXISTS (SELECT 1 FROM organizations o LEFT JOIN organization_identity_archives a ON a.organization_id=o.id
  WHERE (o.name IS NOT NULL OR o.owner_id IS NOT NULL) AND
   (a.organization_id IS NULL OR (o.name,o.description,o.image,o.owner_id) IS DISTINCT FROM (a.name,a.description,a.image,a.owner_id))) THEN
  RAISE EXCEPTION 'Organization identity archive does not match frozen source';
 END IF;
END $$;
--> statement-breakpoint
DROP TRIGGER organizations_identity_guard ON organizations;
--> statement-breakpoint
DROP FUNCTION alia_guard_organization_identity();
--> statement-breakpoint
DROP INDEX "organization_invites_token_key";--> statement-breakpoint
DROP INDEX "organizations_owner_id_idx";--> statement-breakpoint
ALTER TABLE "organizations" ALTER COLUMN "oxy_account_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "organization_invites" DROP COLUMN "token";--> statement-breakpoint
ALTER TABLE "organizations" DROP COLUMN "name";--> statement-breakpoint
ALTER TABLE "organizations" DROP COLUMN "description";--> statement-breakpoint
ALTER TABLE "organizations" DROP COLUMN "image";--> statement-breakpoint
ALTER TABLE "organizations" DROP COLUMN "owner_id";
--> statement-breakpoint
CREATE FUNCTION alia_guard_workspace_reference() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.oxy_account_id IS DISTINCT FROM OLD.oxy_account_id THEN
  RAISE EXCEPTION 'A workspace canonical organization reference cannot be reassigned' USING ERRCODE = '55000';
 END IF;
 RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER organizations_reference_guard BEFORE UPDATE OF oxy_account_id ON organizations FOR EACH ROW EXECUTE FUNCTION alia_guard_workspace_reference();
