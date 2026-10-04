-- oxy:deploy-phase=pre
CREATE TABLE "credit_operation_requests" (
	"operation_id" text NOT NULL,
	"request_id" text PRIMARY KEY NOT NULL,
	"model_reference" text
);
--> statement-breakpoint
CREATE TABLE "credit_operations" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"book_id" text NOT NULL,
	"alia_request_id" text,
	"requested_model" text NOT NULL,
	"captured_at" timestamp with time zone NOT NULL,
	"status" text NOT NULL,
	"grant_kind" text NOT NULL,
	"initial_free_credits" integer NOT NULL,
	"initial_paid_credits" integer NOT NULL,
	"credits_reserved" integer NOT NULL,
	"credits_requested" integer,
	"credits_charged" integer,
	"served_model_id" text,
	"pricing_rule" text,
	"prompt_tokens" integer,
	"completion_tokens" integer,
	"total_tokens" integer,
	"system_prompt_tokens" integer,
	"reasoning_tokens" integer,
	"settled_at" timestamp with time zone,
	CONSTRAINT "credit_operations_alia_request_id_key" UNIQUE("alia_request_id"),
	CONSTRAINT "credit_operations_funding_check" CHECK ("credit_operations"."grant_kind" IN ('free_allowance', 'paid_balance') AND "credit_operations"."initial_free_credits" >= 0 AND "credit_operations"."initial_paid_credits" >= 0),
	CONSTRAINT "credit_operations_terminal_check" CHECK (("credit_operations"."status" = 'admitted' AND "credit_operations"."settled_at" IS NULL AND "credit_operations"."credits_requested" IS NULL AND "credit_operations"."credits_charged" IS NULL) OR ("credit_operations"."status" IN ('settled', 'refunded') AND "credit_operations"."settled_at" IS NOT NULL AND "credit_operations"."credits_requested" IS NOT NULL AND "credit_operations"."credits_charged" IS NOT NULL)),
	CONSTRAINT "credit_operations_status_check" CHECK ("credit_operations"."status" in ('admitted', 'settled', 'refunded')),
	CONSTRAINT "credit_operations_pricing_rule_check" CHECK ("credit_operations"."pricing_rule" in ('catalogue_price', 'base_rate', 'minimum')),
	CONSTRAINT "credit_operations_grant_kind_check" CHECK ("credit_operations"."grant_kind" in ('free_allowance', 'paid_balance')),
	CONSTRAINT "credit_operations_charge_check" CHECK ("credit_operations"."credits_reserved" > 0 AND ("credit_operations"."credits_requested" IS NULL OR "credit_operations"."credits_requested" >= 0) AND ("credit_operations"."credits_charged" IS NULL OR "credit_operations"."credits_charged" >= 0))
);
--> statement-breakpoint
CREATE TABLE "credit_price_book_models" (
	"book_id" text NOT NULL,
	"model_id" text NOT NULL,
	"input_per_m_tok" numeric,
	"output_per_m_tok" numeric,
	"price_version_id" text,
	CONSTRAINT "credit_price_book_models_book_id_model_id_pk" PRIMARY KEY("book_id","model_id"),
	CONSTRAINT "credit_price_book_models_prices_check" CHECK (("credit_price_book_models"."input_per_m_tok" IS NULL AND "credit_price_book_models"."output_per_m_tok" IS NULL) OR ("credit_price_book_models"."input_per_m_tok" >= 0 AND "credit_price_book_models"."output_per_m_tok" >= 0 AND "credit_price_book_models"."input_per_m_tok" IS NOT NULL AND "credit_price_book_models"."output_per_m_tok" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "credit_price_books" (
	"id" text PRIMARY KEY NOT NULL,
	"source" text NOT NULL,
	"formula_version" text NOT NULL,
	"fallback_rule" text NOT NULL,
	"rounding_scale" integer NOT NULL,
	"usd_per_credit" numeric NOT NULL,
	"tokens_per_credit" integer NOT NULL,
	"minimum_credits" integer NOT NULL,
	"initial_reservation" integer NOT NULL,
	"captured_at" timestamp with time zone NOT NULL,
	CONSTRAINT "credit_price_books_source_check" CHECK ("credit_price_books"."source" in ('oxy_catalogue_cache', 'catalogue_unavailable_base_rate')),
	CONSTRAINT "credit_price_books_terms_check" CHECK ("credit_price_books"."rounding_scale" > 0 AND "credit_price_books"."usd_per_credit" > 0 AND "credit_price_books"."tokens_per_credit" > 0 AND "credit_price_books"."minimum_credits" > 0 AND "credit_price_books"."initial_reservation" > 0)
);
--> statement-breakpoint
ALTER TABLE "credit_operation_requests" ADD CONSTRAINT "credit_operation_requests_operation_id_credit_operations_id_fk" FOREIGN KEY ("operation_id") REFERENCES "public"."credit_operations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credit_operations" ADD CONSTRAINT "credit_operations_book_id_credit_price_books_id_fk" FOREIGN KEY ("book_id") REFERENCES "public"."credit_price_books"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credit_price_book_models" ADD CONSTRAINT "credit_price_book_models_book_id_credit_price_books_id_fk" FOREIGN KEY ("book_id") REFERENCES "public"."credit_price_books"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "credit_operation_requests_operation_idx" ON "credit_operation_requests" USING btree ("operation_id");--> statement-breakpoint
CREATE INDEX "credit_operations_user_idx" ON "credit_operations" USING btree ("user_id","captured_at");--> statement-breakpoint
-- Drizzle generates tables/checks. PostgreSQL triggers enforce cross-row immutability;
-- drizzle-kit does not represent triggers in its schema snapshot.
CREATE FUNCTION credit_snapshot_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'credit price snapshot is immutable'; END;
$$;
--> statement-breakpoint
CREATE TRIGGER credit_price_books_immutable BEFORE UPDATE OR DELETE ON credit_price_books FOR EACH ROW EXECUTE FUNCTION credit_snapshot_immutable();
--> statement-breakpoint
CREATE TRIGGER credit_price_book_models_immutable BEFORE UPDATE OR DELETE ON credit_price_book_models FOR EACH ROW EXECUTE FUNCTION credit_snapshot_immutable();
--> statement-breakpoint
CREATE TRIGGER credit_operation_requests_immutable BEFORE UPDATE OR DELETE ON credit_operation_requests FOR EACH ROW EXECUTE FUNCTION credit_snapshot_immutable();
--> statement-breakpoint
CREATE FUNCTION credit_price_models_admission_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM credit_operations WHERE book_id = NEW.book_id) THEN
    RAISE EXCEPTION 'cannot extend an admitted credit price snapshot';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER credit_price_models_admission_guard AFTER INSERT ON credit_price_book_models FOR EACH ROW EXECUTE FUNCTION credit_price_models_admission_guard();
--> statement-breakpoint
CREATE FUNCTION credit_operation_transition_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'credit operation is retained'; END IF;
  IF ROW(OLD.id, OLD.user_id, OLD.book_id, OLD.requested_model, OLD.alia_request_id, OLD.captured_at, OLD.credits_reserved, OLD.grant_kind, OLD.initial_free_credits, OLD.initial_paid_credits)
     IS DISTINCT FROM ROW(NEW.id, NEW.user_id, NEW.book_id, NEW.requested_model, NEW.alia_request_id, NEW.captured_at, NEW.credits_reserved, NEW.grant_kind, NEW.initial_free_credits, NEW.initial_paid_credits) THEN
    RAISE EXCEPTION 'credit admission terms are immutable';
  END IF;
  IF OLD.status <> 'admitted' OR NEW.status NOT IN ('settled', 'refunded') THEN
    RAISE EXCEPTION 'credit operation transition is terminal';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER credit_operation_transition_guard BEFORE UPDATE OR DELETE ON credit_operations FOR EACH ROW EXECUTE FUNCTION credit_operation_transition_guard();

--> statement-breakpoint
CREATE FUNCTION credit_request_admission_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM credit_operations WHERE id = NEW.operation_id AND status = 'admitted') THEN
    RAISE EXCEPTION 'terminal operation cannot accept new Oxy requests';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER credit_request_admission_guard AFTER INSERT ON credit_operation_requests FOR EACH ROW EXECUTE FUNCTION credit_request_admission_guard();
