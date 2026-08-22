-- oxy:deploy-phase=pre
-- A WIDENED check on three tables: it admits every value it admitted before
-- plus 'cheaperinference'. Nothing the previous image writes can be rejected by
-- it, so it is safe while that image still serves — and `pre` is the phase that
-- actually runs, since a zero-capacity deploy exits before its `post` step.
--
ALTER TABLE "alia_model_provider_mappings" DROP CONSTRAINT "alia_model_provider_mappings_provider_check";--> statement-breakpoint
ALTER TABLE "model_configs" DROP CONSTRAINT "model_configs_provider_check";--> statement-breakpoint
ALTER TABLE "provider_keys" DROP CONSTRAINT "provider_keys_provider_check";--> statement-breakpoint
ALTER TABLE "alia_model_provider_mappings" ADD CONSTRAINT "alia_model_provider_mappings_provider_check" CHECK ("alia_model_provider_mappings"."provider" in ('openai', 'anthropic', 'google', 'groq', 'mistral', 'deepseek', 'together', 'replicate', 'cerebras', 'cloudflare', 'openrouter', 'cohere', 'fireworks', 'perplexity', 'xai', 'sambanova', 'hyperbolic', 'novita', 'digitalocean', 'cheaperinference'));--> statement-breakpoint
ALTER TABLE "model_configs" ADD CONSTRAINT "model_configs_provider_check" CHECK ("model_configs"."provider" in ('openai', 'anthropic', 'google', 'groq', 'mistral', 'deepseek', 'together', 'replicate', 'cerebras', 'cloudflare', 'openrouter', 'cohere', 'fireworks', 'perplexity', 'xai', 'sambanova', 'hyperbolic', 'novita', 'digitalocean', 'cheaperinference'));--> statement-breakpoint
ALTER TABLE "provider_keys" ADD CONSTRAINT "provider_keys_provider_check" CHECK ("provider_keys"."provider" in ('openai', 'anthropic', 'google', 'groq', 'mistral', 'deepseek', 'together', 'replicate', 'cerebras', 'cloudflare', 'openrouter', 'cohere', 'fireworks', 'perplexity', 'xai', 'sambanova', 'hyperbolic', 'novita', 'digitalocean', 'cheaperinference'));