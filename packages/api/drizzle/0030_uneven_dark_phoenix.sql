-- Provider keys gain the WHY of their credit, and a period that can renew.
-- `pre`, by default and correctly: every column is additive, `credit_renews`
-- carries a default so existing rows satisfy the CHECK, and the image still
-- serving reads none of them.
ALTER TABLE "provider_keys" ADD COLUMN "description" text;--> statement-breakpoint
ALTER TABLE "provider_keys" ADD COLUMN "credit_renews" text DEFAULT 'never' NOT NULL;--> statement-breakpoint
ALTER TABLE "provider_keys" ADD COLUMN "credit_period_start" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "provider_keys" ADD CONSTRAINT "provider_keys_credit_renews_check" CHECK ("provider_keys"."credit_renews" in ('never', 'weekly', 'monthly'));