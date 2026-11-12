-- oxy:deploy-phase=pre
-- Compatibility boundary for old API instances during the rolling deployment.
-- Legacy updates change the JSON cache without knowing reaction_revision. They
-- advance durable state, but never create a response event or execution authority.
CREATE FUNCTION alia_legacy_reaction_update() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE actor text;
BEGIN
  IF NEW.reaction_revision <> OLD.reaction_revision
     OR coalesce(NEW.reactions, '[]'::jsonb) = coalesce(OLD.reactions, '[]'::jsonb) THEN
    RETURN NEW;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM conversations WHERE oxy_user_id = NEW.oxy_user_id AND conversation_id = NEW.conversation_id) THEN
    RETURN NEW;
  END IF;
  NEW.client_message_id := coalesce(NEW.client_message_id, NEW.id);
  SELECT CASE WHEN NEW.role = 'assistant' THEN coalesce(NEW.agent_info_id, c.agent_id) ELSE NULL END INTO actor
    FROM conversations c WHERE c.oxy_user_id = NEW.oxy_user_id AND c.conversation_id = NEW.conversation_id;
  INSERT INTO message_reaction_states (id, oxy_user_id, conversation_id, message_id, target_actor_id, reactions, revision)
    VALUES (gen_random_uuid()::text, NEW.oxy_user_id, NEW.conversation_id, NEW.client_message_id, actor, coalesce(NEW.reactions, '[]'::jsonb), OLD.reaction_revision + 1)
    ON CONFLICT (oxy_user_id, conversation_id, message_id) DO UPDATE
      SET target_actor_id = EXCLUDED.target_actor_id, reactions = EXCLUDED.reactions,
          revision = greatest(message_reaction_states.revision, OLD.reaction_revision) + 1, updated_at = now()
    RETURNING revision INTO NEW.reaction_revision;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER messages_legacy_reaction_update BEFORE UPDATE OF reactions ON messages
  FOR EACH ROW EXECUTE FUNCTION alia_legacy_reaction_update();
--> statement-breakpoint
-- A legacy delete/reinsert must restore the cache BEFORE its next toggle reads it.
-- This only reads existing state: no revision increment and no response event.
CREATE FUNCTION alia_restore_reaction_cache() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE held record;
BEGIN
  SELECT s.reactions, s.revision INTO held FROM message_reaction_states s
    WHERE s.oxy_user_id = NEW.oxy_user_id AND s.conversation_id = NEW.conversation_id
      AND s.message_id = coalesce(NEW.client_message_id, NEW.id)
      AND s.target_actor_id IS NOT DISTINCT FROM CASE WHEN NEW.role = 'assistant'
        THEN coalesce(NEW.agent_info_id, (SELECT c.agent_id FROM conversations c WHERE c.oxy_user_id = NEW.oxy_user_id AND c.conversation_id = NEW.conversation_id)) ELSE NULL END;
  IF FOUND THEN
    NEW.reactions := CASE WHEN held.reactions = '[]'::jsonb THEN NULL ELSE held.reactions END;
    NEW.reaction_revision := held.revision;
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER messages_restore_reaction_cache BEFORE INSERT ON messages
  FOR EACH ROW EXECUTE FUNCTION alia_restore_reaction_cache();

--> statement-breakpoint
-- Seed feedback that predates the durable store in the SAME transaction as the
-- compatibility triggers. CREATE TRIGGER already fences concurrent message
-- writers until commit; a later separate migration would leave an unprotected gap.
-- Read only owned, nonempty feedback and never replace a newer canonical state.
INSERT INTO message_reaction_states
  (id, oxy_user_id, conversation_id, message_id, target_actor_id, reactions, revision)
SELECT gen_random_uuid()::text, m.oxy_user_id, m.conversation_id,
  coalesce(m.client_message_id, m.id),
  CASE WHEN m.role = 'assistant' THEN coalesce(m.agent_info_id, c.agent_id) ELSE NULL END,
  m.reactions, m.reaction_revision
FROM messages m
JOIN conversations c ON c.oxy_user_id = m.oxy_user_id AND c.conversation_id = m.conversation_id
WHERE m.reactions IS NOT NULL AND m.reactions <> '[]'::jsonb
ON CONFLICT (oxy_user_id, conversation_id, message_id) DO NOTHING;
