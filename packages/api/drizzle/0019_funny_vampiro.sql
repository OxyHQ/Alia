-- oxy:deploy-phase=pre
ALTER TABLE "chat_analytics" ADD COLUMN "conversation_id" text;--> statement-breakpoint
ALTER TABLE "chat_analytics" ADD COLUMN "alia_model_id" text;--> statement-breakpoint
ALTER TABLE "chat_analytics" ADD COLUMN "skill_id" text;