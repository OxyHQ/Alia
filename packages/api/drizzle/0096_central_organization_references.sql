-- oxy:deploy-phase=pre
CREATE TABLE "organization_identity_archives" (
	"organization_id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"image" text,
	"owner_id" text NOT NULL,
	"archived_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL
);
--> statement-breakpoint
ALTER TABLE "organizations" ALTER COLUMN "name" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "organizations" ALTER COLUMN "owner_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "organizations" ADD COLUMN "oxy_account_id" text;--> statement-breakpoint
ALTER TABLE "organization_identity_archives" ADD CONSTRAINT "organization_identity_archives_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "organizations_oxy_account_key" ON "organizations" USING btree ("oxy_account_id");
--> statement-breakpoint
LOCK TABLE organizations, organization_members, organization_invites IN ACCESS EXCLUSIVE MODE;
--> statement-breakpoint
INSERT INTO organization_identity_archives (organization_id, name, description, image, owner_id)
SELECT id, name, description, image, owner_id FROM organizations;
--> statement-breakpoint
CREATE FUNCTION alia_reject_organization_evidence_write() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'Organization history is immutable; manage organization identity and members in Oxy' USING ERRCODE = '55000'; END $$;
--> statement-breakpoint
CREATE TRIGGER organization_identity_archives_immutable BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE ON organization_identity_archives FOR EACH STATEMENT EXECUTE FUNCTION alia_reject_organization_evidence_write();
--> statement-breakpoint
CREATE TRIGGER organization_members_retired BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE ON organization_members FOR EACH STATEMENT EXECUTE FUNCTION alia_reject_organization_evidence_write();
--> statement-breakpoint
CREATE TRIGGER organization_invites_retired BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE ON organization_invites FOR EACH STATEMENT EXECUTE FUNCTION alia_reject_organization_evidence_write();
--> statement-breakpoint
CREATE FUNCTION alia_guard_organization_identity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP = 'INSERT' THEN
  IF NEW.oxy_account_id IS NULL OR NEW.name IS NOT NULL OR NEW.description IS NOT NULL OR NEW.image IS NOT NULL OR NEW.owner_id IS NOT NULL THEN
   RAISE EXCEPTION 'Select an Oxy organization; legacy organization creation is retired' USING ERRCODE = '55000';
  END IF;
 ELSIF (NEW.name,NEW.description,NEW.image,NEW.owner_id) IS DISTINCT FROM (OLD.name,OLD.description,OLD.image,OLD.owner_id) THEN
  RAISE EXCEPTION 'Organization identity is managed in Oxy' USING ERRCODE = '55000';
 END IF;
 IF TG_OP = 'UPDATE' AND OLD.oxy_account_id IS NOT NULL AND NEW.oxy_account_id IS DISTINCT FROM OLD.oxy_account_id THEN
  RAISE EXCEPTION 'A workspace canonical organization reference cannot be reassigned' USING ERRCODE = '55000';
 END IF;
 RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER organizations_identity_guard BEFORE INSERT OR UPDATE ON organizations FOR EACH ROW EXECUTE FUNCTION alia_guard_organization_identity();
