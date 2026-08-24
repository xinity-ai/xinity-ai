-- Custom SQL migration file, put your code below! --

-- One notification convention for every table: the channel is the table name and the
-- payload is the key column named by the trigger. Listeners that care about a single
-- key read the payload
-- Adding a table later is a CREATE TRIGGER, with no new function or payload contract.
CREATE OR REPLACE FUNCTION notify_row_change() RETURNS TRIGGER AS $$
DECLARE
  key_column text := TG_ARGV[0];
  old_key text;
  new_key text;
BEGIN
  IF (TG_OP = 'DELETE') THEN
    PERFORM pg_notify(TG_TABLE_NAME, to_jsonb(OLD) ->> key_column);
    RETURN NULL;
  END IF;

  new_key := to_jsonb(NEW) ->> key_column;
  PERFORM pg_notify(TG_TABLE_NAME, new_key);

  -- An update that moves a row between keys leaves the old key stale too.
  IF (TG_OP = 'UPDATE') THEN
    old_key := to_jsonb(OLD) ->> key_column;
    IF (old_key IS DISTINCT FROM new_key) THEN
      PERFORM pg_notify(TG_TABLE_NAME, old_key);
    END IF;
  END IF;

  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS ai_node_change_trigger ON "ai_node";
CREATE TRIGGER ai_node_change_trigger
AFTER INSERT OR UPDATE OR DELETE ON "ai_node"
FOR EACH ROW EXECUTE FUNCTION notify_row_change('id');

DROP TRIGGER IF EXISTS model_installation_change_trigger ON "model_installation";
CREATE TRIGGER model_installation_change_trigger
AFTER INSERT OR UPDATE OR DELETE ON "model_installation"
FOR EACH ROW EXECUTE FUNCTION notify_row_change('node_id');

DROP TRIGGER IF EXISTS model_installation_state_change_trigger ON "model_installation_state";
CREATE TRIGGER model_installation_state_change_trigger
AFTER INSERT OR UPDATE OR DELETE ON "model_installation_state"
FOR EACH ROW EXECUTE FUNCTION notify_row_change('id');

DROP TRIGGER IF EXISTS model_deployment_change_trigger ON "model_deployment";
CREATE TRIGGER model_deployment_change_trigger
AFTER INSERT OR UPDATE OR DELETE ON "model_deployment"
FOR EACH ROW EXECUTE FUNCTION notify_row_change('id');

DROP FUNCTION IF EXISTS notify_ai_node_change();
DROP FUNCTION IF EXISTS notify_model_installation_change();
DROP FUNCTION IF EXISTS notify_model_deployment_change();
