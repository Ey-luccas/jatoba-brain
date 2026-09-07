ALTER TABLE tasks
  ADD CONSTRAINT tasks_status_contract
  CHECK (status IN ('pending','running','blocked','completed','failed','cancelled'))
  NOT VALID;
ALTER TABLE tasks VALIDATE CONSTRAINT tasks_status_contract;

CREATE FUNCTION validate_agent_identity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.agent_key IS NOT NULL AND NOT EXISTS (SELECT 1 FROM agents WHERE key=NEW.agent_key) THEN
    RAISE EXCEPTION 'Agent does not exist: %', NEW.agent_key;
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER validate_task_agent BEFORE INSERT OR UPDATE ON tasks
  FOR EACH ROW EXECUTE FUNCTION validate_agent_identity();
CREATE TRIGGER validate_session_agent BEFORE INSERT OR UPDATE ON sessions
  FOR EACH ROW EXECUTE FUNCTION validate_agent_identity();
