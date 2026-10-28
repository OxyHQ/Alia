-- oxy:deploy-phase=pre
-- Additive: the PKCE verifier of an integration OAuth handshake, encrypted by the API; nullable, so a running image that never writes it keeps working.
ALTER TABLE "oauth_states" ADD COLUMN "code_verifier" text;
