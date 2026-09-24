-- oxy:deploy-phase=pre
ALTER TABLE "agent_approval_requests" DROP CONSTRAINT "agent_approval_status_check";--> statement-breakpoint
ALTER TABLE "agent_approval_requests" ALTER COLUMN "thread_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "agent_approval_requests" ADD CONSTRAINT "agent_approval_status_check" CHECK ("agent_approval_requests"."status" in ('pending', 'approved', 'denied', 'expired', 'cancelled', 'executed'));