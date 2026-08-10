-- oxy:deploy-phase=pre
ALTER TABLE "reports" ADD COLUMN "decision_status" text;--> statement-breakpoint
ALTER TABLE "reports" ADD COLUMN "decided_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "reports" ADD COLUMN "enforced_action" text;--> statement-breakpoint
ALTER TABLE "reports" ADD COLUMN "enforced_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "reports" ADD CONSTRAINT "reports_enforced_action_check" CHECK ("reports"."enforced_action" in ('restrict', 'restore', 'demote', 'manual_review', 'none'));