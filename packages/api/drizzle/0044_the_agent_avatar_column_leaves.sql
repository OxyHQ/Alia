-- oxy:deploy-phase=post
-- The CONTRACT half of 0043. `post`, without ambiguity: the image running
-- before this deploy still SELECTs `messages.*`, so it selects this column.
--
-- Nothing is lost. Measured against production on 2026-08-25: 143 messages, of
-- which ZERO carried a non-null `agent_info_avatar` — the column is only ever
-- written by the `delegateToAgent` path, and a delegated turn has never
-- produced one. The census had positive controls in the same query (the row
-- counts themselves were non-zero), so "no rows have a value" and "the query
-- reached nothing" are distinguishable observations.

ALTER TABLE "messages" DROP COLUMN "agent_info_avatar";
