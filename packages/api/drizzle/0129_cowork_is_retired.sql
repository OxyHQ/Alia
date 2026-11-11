-- oxy:deploy-phase=post
--
-- Retires Cowork. The desktop client is gone and the image this rollout ships has no reader or
-- writer of `cowork_devices`, `agent_threads.execution_target` or `agent_threads.cowork_device_id`
-- (a thread is always a server-side thread). Post phase, so they are dropped only after the previous
-- image, which still selects those columns, has drained. Production held 0 devices and 0 cowork
-- threads when this was written.
ALTER TABLE "cowork_devices" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP TABLE "cowork_devices" CASCADE;--> statement-breakpoint
ALTER TABLE "agent_threads" DROP CONSTRAINT "agent_threads_execution_target_check";--> statement-breakpoint
ALTER TABLE "agent_threads" DROP CONSTRAINT "agent_threads_cowork_target_check";--> statement-breakpoint
ALTER TABLE "agent_threads" DROP COLUMN "execution_target";--> statement-breakpoint
ALTER TABLE "agent_threads" DROP COLUMN "cowork_device_id";