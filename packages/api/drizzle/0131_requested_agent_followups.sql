-- oxy:deploy-phase=pre
ALTER TABLE "agent_work_items" ADD COLUMN "delivery_mode" text DEFAULT 'initiative' NOT NULL;--> statement-breakpoint
ALTER TABLE "agent_work_items" ADD COLUMN "delivered_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "agent_work_items" ADD COLUMN "source_tool_call_id" text;--> statement-breakpoint
CREATE UNIQUE INDEX "agent_work_source_call_key" ON "agent_work_items" USING btree ("source_session_id","source_tool_call_id");--> statement-breakpoint
CREATE INDEX "agent_work_delivery_idx" ON "agent_work_items" USING btree ("updated_at") WHERE "agent_work_items"."delivery_mode" = 'requested' and "agent_work_items"."delivered_at" is null and "agent_work_items"."status" in ('completed', 'failed');--> statement-breakpoint
ALTER TABLE "agent_work_items" ADD CONSTRAINT "agent_work_delivery_mode_check" CHECK ("agent_work_items"."delivery_mode" in ('initiative', 'requested'));