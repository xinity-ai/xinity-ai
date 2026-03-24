-- Custom SQL migration file, put your code below! --

-- Function to notify changes on ai_node
CREATE OR REPLACE FUNCTION notify_ai_node_change() RETURNS TRIGGER AS $$
DECLARE
  record_id uuid;
BEGIN
  IF (TG_OP = 'DELETE') THEN
    record_id := OLD.id;
  ELSE
    record_id := NEW.id;
  END IF;
  PERFORM pg_notify('ai_node:' || record_id, '{}');
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

-- Trigger for ai_node
DROP TRIGGER IF EXISTS ai_node_change_trigger ON "ai_node";
CREATE TRIGGER ai_node_change_trigger
AFTER INSERT OR UPDATE OR DELETE ON "ai_node"
FOR EACH ROW EXECUTE FUNCTION notify_ai_node_change();

-- Function to notify changes on model_installation
CREATE OR REPLACE FUNCTION notify_model_installation_change() RETURNS TRIGGER AS $$
BEGIN
  IF (TG_OP = 'DELETE') THEN
    PERFORM pg_notify('ai_node:' || OLD."node_id", '{}');
  ELSIF (TG_OP = 'UPDATE') THEN
    PERFORM pg_notify('ai_node:' || NEW."node_id", '{}');
    IF (OLD."node_id" != NEW."node_id") THEN
      PERFORM pg_notify('ai_node:' || OLD."node_id", '{}');
    END IF;
  ELSE -- INSERT
    PERFORM pg_notify('ai_node:' || NEW."node_id", '{}');
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

-- Trigger for model_installation
DROP TRIGGER IF EXISTS model_installation_change_trigger ON "model_installation";
CREATE TRIGGER model_installation_change_trigger
AFTER INSERT OR UPDATE OR DELETE ON "model_installation"
FOR EACH ROW EXECUTE FUNCTION notify_model_installation_change();

-- Function to notify changes on model_deployment
CREATE OR REPLACE FUNCTION notify_model_deployment_change() RETURNS TRIGGER AS $$
DECLARE
  record_id uuid;
BEGIN
  IF (TG_OP = 'DELETE') THEN
    record_id := OLD.id;
  ELSE
    record_id := NEW.id;
  END IF;
  PERFORM pg_notify('model_deployment:' || record_id, '{}');
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

-- Trigger for model_deployment
DROP TRIGGER IF EXISTS model_deployment_change_trigger ON "model_deployment";
CREATE TRIGGER model_deployment_change_trigger
AFTER INSERT OR UPDATE OR DELETE ON "model_deployment"
FOR EACH ROW EXECUTE FUNCTION notify_model_deployment_change();
