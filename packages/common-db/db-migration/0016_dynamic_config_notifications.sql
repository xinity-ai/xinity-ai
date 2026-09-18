-- Custom SQL migration file, put your code below! --

-- Reuses notify_row_change from 0012: the channel is the table name and the payload is the key.
DROP TRIGGER IF EXISTS dynamic_config_change_trigger ON "dynamic_config";
CREATE TRIGGER dynamic_config_change_trigger
AFTER INSERT OR UPDATE OR DELETE ON "dynamic_config"
FOR EACH ROW EXECUTE FUNCTION notify_row_change('key');
