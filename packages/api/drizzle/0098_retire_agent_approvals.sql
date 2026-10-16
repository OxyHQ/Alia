-- oxy:deploy-phase=post
-- No agent asks for approval (ADR 0020 §3): an agent's configuration IS its
-- permission, enforced by Oxy on every call. The code that filed, decided and
-- ran approvals is deleted in the same change, so this drops what it stored:
--
--  - `agent_approval_requests`, every approval ever filed (pending ones
--    included: nothing will ever decide them, and nothing reads them);
--  - `agent_threads.approval_mode` (`ask` | `supervised_auto`), a per-thread
--    approval setting nothing reads any more.
--
-- `post`, without ambiguity: the image this rollout replaces still files and
-- decides approvals and still writes `approval_mode` on every thread it
-- creates. There is no `pre` half: nothing replaces either, so this contracts
-- with nothing to expand first.
DROP TABLE "agent_approval_requests" CASCADE;--> statement-breakpoint
ALTER TABLE "agent_threads" DROP CONSTRAINT "agent_threads_approval_mode_check";--> statement-breakpoint
ALTER TABLE "agent_threads" DROP COLUMN "approval_mode";
