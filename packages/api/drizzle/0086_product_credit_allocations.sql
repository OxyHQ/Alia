-- oxy:deploy-phase=pre
CREATE TABLE "product_credit_allocations" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"product_id" text NOT NULL,
	"segment_id" text NOT NULL,
	"offer_id" text NOT NULL,
	"offer_version" integer NOT NULL,
	"quota_key" text NOT NULL,
	"unit" text NOT NULL,
	"period_start" timestamp with time zone NOT NULL,
	"period_end" timestamp with time zone NOT NULL,
	"included" integer NOT NULL,
	"consumed" integer DEFAULT 0 NOT NULL,
	"reserved" integer DEFAULT 0 NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	CONSTRAINT "product_credit_allocation_conservation" CHECK ("product_credit_allocations"."included" >= 0 AND "product_credit_allocations"."consumed" >= 0 AND "product_credit_allocations"."reserved" >= 0 AND "product_credit_allocations"."consumed" + "product_credit_allocations"."reserved" <= "product_credit_allocations"."included"),
	CONSTRAINT "product_credit_allocation_period" CHECK ("product_credit_allocations"."period_end" > "product_credit_allocations"."period_start")
);
--> statement-breakpoint
ALTER TABLE "credit_operations" DROP CONSTRAINT "credit_operations_funding_check";--> statement-breakpoint
ALTER TABLE "credit_operations" DROP CONSTRAINT "credit_operations_grant_kind_check";--> statement-breakpoint
ALTER TABLE "credit_operations" ADD COLUMN "product_allocation_id" text;--> statement-breakpoint
ALTER TABLE "credit_operations" ADD CONSTRAINT "credit_operations_product_allocation_id_product_credit_allocations_id_fk" FOREIGN KEY ("product_allocation_id") REFERENCES "public"."product_credit_allocations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credit_operations" ADD CONSTRAINT "credit_operation_product_source" CHECK (("credit_operations"."grant_kind" = 'product_allowance' AND "credit_operations"."product_allocation_id" IS NOT NULL) OR ("credit_operations"."grant_kind" <> 'product_allowance' AND "credit_operations"."product_allocation_id" IS NULL));--> statement-breakpoint
ALTER TABLE "credit_operations" ADD CONSTRAINT "credit_operations_funding_check" CHECK ("credit_operations"."grant_kind" IN ('free_allowance', 'paid_balance', 'product_allowance') AND "credit_operations"."initial_free_credits" >= 0 AND "credit_operations"."initial_paid_credits" >= 0);--> statement-breakpoint
ALTER TABLE "credit_operations" ADD CONSTRAINT "credit_operations_grant_kind_check" CHECK ("credit_operations"."grant_kind" in ('free_allowance', 'paid_balance', 'product_allowance'));