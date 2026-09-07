ALTER TABLE agents ADD COLUMN provider text;
ALTER TABLE agents ADD COLUMN model text;
ALTER TABLE agents ADD COLUMN capabilities text[] NOT NULL DEFAULT '{}';
ALTER TABLE agents ADD COLUMN metadata jsonb NOT NULL DEFAULT '{}';
ALTER TABLE sessions ADD COLUMN repository_id uuid REFERENCES repositories(id);
ALTER TABLE sessions ADD COLUMN status text NOT NULL DEFAULT 'active';
UPDATE sessions SET status='completed' WHERE finished_at IS NOT NULL;
ALTER TABLE tasks ADD COLUMN session_id uuid REFERENCES sessions(id);
ALTER TABLE memories ADD COLUMN session_id uuid REFERENCES sessions(id);
ALTER TABLE decisions ADD COLUMN session_id uuid REFERENCES sessions(id);
ALTER TABLE errors ADD COLUMN session_id uuid REFERENCES sessions(id);
ALTER TABLE checkpoints ADD COLUMN session_id uuid REFERENCES sessions(id);
ALTER TABLE decisions ADD COLUMN metadata jsonb NOT NULL DEFAULT '{}';
ALTER TABLE errors ADD COLUMN metadata jsonb NOT NULL DEFAULT '{}';

CREATE TABLE solutions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES projects(id),
  repository_id uuid REFERENCES repositories(id),
  task_id uuid REFERENCES tasks(id),
  session_id uuid REFERENCES sessions(id),
  error_id uuid NOT NULL REFERENCES errors(id),
  agent_key text,
  solution text NOT NULL,
  result text,
  metadata jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON solutions(project_id, repository_id, created_at DESC);
CREATE INDEX ON memories(project_id, repository_id, created_at DESC);
CREATE INDEX ON tasks(project_id, session_id);

-- Reject inconsistent references even for callers using SQL or the REST API.
-- Existing rows are preserved; report legacy inconsistencies before applying.
DO $$ DECLARE t text; bad boolean; BEGIN
  FOREACH t IN ARRAY ARRAY['tasks','memories','decisions','errors','changes','checkpoints'] LOOP
    EXECUTE format('SELECT EXISTS(SELECT 1 FROM %I x JOIN repositories r ON r.id=x.repository_id WHERE x.project_id<>r.project_id)',t) INTO bad;
    IF bad THEN RAISE EXCEPTION 'Cross-project repository reference in %. Repair explicitly before migrating.',t; END IF;
  END LOOP;
  FOREACH t IN ARRAY ARRAY['memories','decisions','errors','changes','checkpoints'] LOOP
    EXECUTE format('SELECT EXISTS(SELECT 1 FROM %I x JOIN tasks t ON t.id=x.task_id WHERE x.project_id<>t.project_id OR (x.repository_id IS NOT NULL AND t.repository_id IS NOT NULL AND x.repository_id<>t.repository_id))',t) INTO bad;
    IF bad THEN RAISE EXCEPTION 'Inconsistent task reference in %. Repair explicitly before migrating.',t; END IF;
  END LOOP;
END $$;

CREATE FUNCTION validate_memory_scope() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE j jsonb := to_jsonb(NEW); ref record; sid uuid; tid uuid; BEGIN
  IF NEW.repository_id IS NOT NULL THEN
    SELECT * INTO ref FROM repositories WHERE id=NEW.repository_id;
    IF NOT FOUND OR ref.project_id<>NEW.project_id THEN RAISE EXCEPTION 'Repository does not belong to project'; END IF;
  END IF;
  tid := COALESCE((j->>'task_id')::uuid, (j->>'parent_task_id')::uuid);
  IF tid IS NOT NULL THEN
    SELECT * INTO ref FROM tasks WHERE id=tid;
    IF NOT FOUND OR ref.project_id<>NEW.project_id THEN RAISE EXCEPTION 'Task does not belong to project'; END IF;
    IF NEW.repository_id IS NULL THEN NEW.repository_id:=ref.repository_id;
    ELSIF ref.repository_id IS NOT NULL AND ref.repository_id<>NEW.repository_id THEN RAISE EXCEPTION 'Task repository mismatch'; END IF;
  END IF;
  sid := (j->>'session_id')::uuid;
  IF sid IS NOT NULL THEN
    SELECT * INTO ref FROM sessions WHERE id=sid;
    IF NOT FOUND OR ref.project_id<>NEW.project_id THEN RAISE EXCEPTION 'Session does not belong to project'; END IF;
    IF NEW.repository_id IS NULL THEN NEW.repository_id:=ref.repository_id;
    ELSIF ref.repository_id IS NOT NULL AND ref.repository_id<>NEW.repository_id THEN RAISE EXCEPTION 'Session repository mismatch'; END IF;
  END IF;
  IF j->>'error_id' IS NOT NULL THEN
    SELECT * INTO ref FROM errors WHERE id=(j->>'error_id')::uuid;
    IF NOT FOUND OR ref.project_id<>NEW.project_id THEN RAISE EXCEPTION 'Error does not belong to project'; END IF;
    IF NEW.repository_id IS NULL THEN NEW.repository_id:=ref.repository_id;
    ELSIF ref.repository_id IS NOT NULL AND ref.repository_id<>NEW.repository_id THEN RAISE EXCEPTION 'Error repository mismatch'; END IF;
  END IF;
  RETURN NEW;
END $$;
DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['sessions','tasks','memories','decisions','errors','solutions','changes','checkpoints'] LOOP
    EXECUTE format('CREATE TRIGGER validate_scope BEFORE INSERT OR UPDATE ON %I FOR EACH ROW EXECUTE FUNCTION validate_memory_scope()',t);
  END LOOP;
END $$;
