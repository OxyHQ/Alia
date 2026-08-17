-- oxy:deploy-phase=pre
--
-- A settled receipt cannot be rewritten, enforced by the DATABASE.
--
-- ADR 0005: "A receipt records what happened. Changing a plan, renaming a plan,
-- altering an allowance or correcting an entitlement changes what happens next;
-- it never rewrites what a customer was already charged." Until now that held
-- only because `transactionRepository.ts` happens to export one writer and no
-- update — a convention any future function can break silently, in the one table
-- where a silent break is a financial fact being altered.
--
-- ## Hand-written, because drizzle has no way to say this
--
-- A trigger is not part of the drizzle schema, so `drizzle-kit generate` neither
-- produces nor drops it. `0023_snapshot.json` is therefore a copy of `0022`'s
-- with a fresh id: the schema drizzle models is unchanged, and the chain stays
-- intact so the next generated migration diffs against the right state.
--
-- ## A trigger, not a REVOKE and not row-level security
--
-- - `REVOKE UPDATE, DELETE` needs a role split this service does not have, and
--   the table OWNER bypasses it anyway.
-- - Row-level security is worse than nothing here: a `FOR UPDATE USING (false)`
--   policy makes the statement affect ZERO ROWS and report success, so a caller
--   rewriting a receipt would see the same result as one that changed nothing.
--   The owner also bypasses RLS unless FORCE is set, which is a second thing to
--   remember.
-- - A `BEFORE UPDATE OR DELETE` trigger applies to every role including the
--   owner, and it RAISES. Loud beats silent for a financial invariant.
--
-- The `transactions` schema comment warns that a stored generated column is
-- computed after a BEFORE UPDATE trigger runs, so `NEW.dedup_key` is NULL inside
-- one. That warning is why this trigger reads no column at all: it raises
-- unconditionally, so no UPDATE ever completes and the generated column is never
-- consulted from inside it.
--
-- ## `pre`, and the phase is a measurement rather than a habit
--
-- The rule is that `post` carries anything that NARROWS, and this narrows. It is
-- `pre` because a `pre` migration's test is whether it is safe while the
-- PREVIOUS image still serves — and the previous image performs no UPDATE and no
-- DELETE on this table, measured across the whole package (`billing-paths.json`
-- lists every writer of all seven billing tables; `transactions` has exactly one
-- and it inserts). The alternative is worse than merely unnecessary: the deploy
-- runs its `post` phase as a separate step that a zero-capacity service exits
-- before reaching, so a `post` marker here would read as applied and never run.
--
-- ## Correcting a charge
--
-- Forward, as a new row: a refund, a credit or an adjustment. `transactions`
-- already carries `refund` in `TRANSACTION_TYPES` for exactly this.
CREATE OR REPLACE FUNCTION transactions_refuse_rewrite() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'transactions is append-only: % refused on a settled receipt', TG_OP
    USING ERRCODE = 'restrict_violation',
          CONSTRAINT = 'transactions_append_only',
          HINT = 'Record the correction forward as a new refund or adjustment row (ADR 0005).';
END;
$$;--> statement-breakpoint
CREATE TRIGGER transactions_append_only
  BEFORE UPDATE OR DELETE ON "transactions"
  FOR EACH ROW EXECUTE FUNCTION transactions_refuse_rewrite();
