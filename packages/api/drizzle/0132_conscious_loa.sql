-- oxy:deploy-phase=pre
CREATE TABLE "agent_work_revocations" (
	"oxy_task_id" text PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL
);
