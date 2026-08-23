-- oxy:deploy-phase=pre
-- Widen the provider CHECK on the three columns that carry a provider name, so
-- `elevenlabs` may be written. `pre`: the new image writes an `elevenlabs`
-- mapping row on its first seed, so the constraint has to be wide BEFORE the
-- rollout — and a wider CHECK is invisible to the image still serving.
ALTER TABLE "alia_model_provider_mappings" DROP CONSTRAINT "alia_model_provider_mappings_provider_check";--> statement-breakpoint
ALTER TABLE "model_configs" DROP CONSTRAINT "model_configs_provider_check";--> statement-breakpoint
ALTER TABLE "provider_keys" DROP CONSTRAINT "provider_keys_provider_check";--> statement-breakpoint
ALTER TABLE "alia_model_provider_mappings" ADD CONSTRAINT "alia_model_provider_mappings_provider_check" CHECK ("alia_model_provider_mappings"."provider" in ('openai', 'anthropic', 'google', 'groq', 'mistral', 'deepseek', 'together', 'replicate', 'cerebras', 'cloudflare', 'openrouter', 'cohere', 'fireworks', 'perplexity', 'xai', 'sambanova', 'hyperbolic', 'novita', 'digitalocean', 'cheaperinference', 'elevenlabs'));--> statement-breakpoint
ALTER TABLE "model_configs" ADD CONSTRAINT "model_configs_provider_check" CHECK ("model_configs"."provider" in ('openai', 'anthropic', 'google', 'groq', 'mistral', 'deepseek', 'together', 'replicate', 'cerebras', 'cloudflare', 'openrouter', 'cohere', 'fireworks', 'perplexity', 'xai', 'sambanova', 'hyperbolic', 'novita', 'digitalocean', 'cheaperinference', 'elevenlabs'));--> statement-breakpoint
ALTER TABLE "provider_keys" ADD CONSTRAINT "provider_keys_provider_check" CHECK ("provider_keys"."provider" in ('openai', 'anthropic', 'google', 'groq', 'mistral', 'deepseek', 'together', 'replicate', 'cerebras', 'cloudflare', 'openrouter', 'cohere', 'fireworks', 'perplexity', 'xai', 'sambanova', 'hyperbolic', 'novita', 'digitalocean', 'cheaperinference', 'elevenlabs'));