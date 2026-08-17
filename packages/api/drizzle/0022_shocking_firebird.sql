-- oxy:deploy-phase=pre
ALTER TABLE "cost_entries" ADD COLUMN "grant_kind" text;--> statement-breakpoint
ALTER TABLE "voice_call_usage" ADD COLUMN "grant_kind" text;--> statement-breakpoint
ALTER TABLE "cost_entries" ADD CONSTRAINT "cost_entries_grant_kind_check" CHECK ("cost_entries"."grant_kind" in ('free_allowance', 'paid_balance'));--> statement-breakpoint
ALTER TABLE "voice_call_usage" ADD CONSTRAINT "voice_call_usage_grant_kind_check" CHECK ("voice_call_usage"."grant_kind" in ('free_allowance', 'paid_balance'));