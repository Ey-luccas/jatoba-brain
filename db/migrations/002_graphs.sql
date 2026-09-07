CREATE TABLE repository_graphs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES projects(id),
  repository_id uuid NOT NULL UNIQUE REFERENCES repositories(id),
  graph_path text,
  git_commit text,
  status text NOT NULL CHECK (status IN ('INDEXING','READY','ERROR','STALE')),
  nodes_count integer NOT NULL DEFAULT 0,
  edges_count integer NOT NULL DEFAULT 0,
  generated_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  error_code text
);
CREATE TRIGGER validate_scope BEFORE INSERT OR UPDATE ON repository_graphs
  FOR EACH ROW EXECUTE FUNCTION validate_memory_scope();

CREATE TABLE work_entities (
  project_id uuid NOT NULL REFERENCES projects(id),
  entity_type text NOT NULL,
  entity_id text NOT NULL,
  PRIMARY KEY(project_id,entity_type,entity_id)
);
CREATE TABLE memory_edges (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES projects(id),
  repository_id uuid REFERENCES repositories(id),
  source_type text NOT NULL,
  source_id text NOT NULL,
  relation_type text NOT NULL CHECK (relation_type IN
    ('EXECUTED','CHANGED','CREATED','FOUND','RESOLVED_BY','PRODUCED','FINISHED_AT','DEPENDS_ON','AFFECTS','RELATED_TO','ASSIGNED_TO','HANDED_OFF_TO')),
  target_type text NOT NULL,
  target_id text NOT NULL,
  metadata jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY(project_id,source_type,source_id) REFERENCES work_entities,
  FOREIGN KEY(project_id,target_type,target_id) REFERENCES work_entities,
  UNIQUE NULLS NOT DISTINCT(project_id,repository_id,source_type,source_id,relation_type,target_type,target_id)
);
CREATE INDEX ON memory_edges(project_id,source_type,source_id);
CREATE INDEX ON memory_edges(project_id,target_type,target_id);
CREATE INDEX ON memory_edges(project_id,repository_id,created_at);
CREATE TRIGGER validate_scope BEFORE INSERT OR UPDATE ON memory_edges FOR EACH ROW EXECUTE FUNCTION validate_memory_scope();
CREATE TABLE work_events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  project_id uuid NOT NULL REFERENCES projects(id),
  repository_id uuid REFERENCES repositories(id),
  task_id uuid REFERENCES tasks(id),
  agent_key text,
  entity_type text NOT NULL,
  entity_id text NOT NULL,
  event text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX ON work_events(project_id,repository_id,created_at,id);
CREATE INDEX ON work_events(task_id,created_at,id);

CREATE FUNCTION add_work_edge(p uuid,r uuid,st text,si text,rel text,tt text,ti text,meta jsonb DEFAULT '{}')
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  IF si IS NULL OR ti IS NULL THEN RETURN; END IF;
  INSERT INTO work_entities VALUES(p,st,si),(p,tt,ti) ON CONFLICT DO NOTHING;
  INSERT INTO memory_edges(project_id,repository_id,source_type,source_id,relation_type,target_type,target_id,metadata)
    VALUES(p,r,st,si,rel,tt,ti,meta) ON CONFLICT DO NOTHING;
END $$;

CREATE FUNCTION capture_work() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE j jsonb:=to_jsonb(NEW); kind text; task uuid; item jsonb; body text; event_name text;
BEGIN
  kind:=CASE TG_TABLE_NAME WHEN 'tasks' THEN 'TASK' WHEN 'decisions' THEN 'DECISION' WHEN 'errors' THEN 'ERROR'
    WHEN 'solutions' THEN 'SOLUTION' WHEN 'checkpoints' THEN 'CHECKPOINT' WHEN 'changes' THEN 'CHANGE'
    WHEN 'sessions' THEN 'SESSION' ELSE 'MEMORY' END;
  task:=CASE WHEN kind='TASK' THEN NEW.id ELSE (j->>'task_id')::uuid END;
  INSERT INTO work_entities VALUES(NEW.project_id,kind,NEW.id::text) ON CONFLICT DO NOTHING;
  IF TG_OP='UPDATE' AND (to_jsonb(OLD)->>'status') IS NOT DISTINCT FROM (j->>'status')
     AND (to_jsonb(OLD)->>'summary') IS NOT DISTINCT FROM (j->>'summary')
     AND (to_jsonb(OLD)->>'solution') IS NOT DISTINCT FROM (j->>'solution')
     AND (to_jsonb(OLD)->>'agent_key') IS NOT DISTINCT FROM (j->>'agent_key') THEN RETURN NEW; END IF;
  event_name:=kind || '_' || CASE WHEN TG_OP='INSERT' THEN 'CREATED' ELSE upper(COALESCE(j->>'status','UPDATED')) END;
  INSERT INTO work_events(project_id,repository_id,task_id,agent_key,entity_type,entity_id,event)
    VALUES(NEW.project_id,NEW.repository_id,task,j->>'agent_key',kind,NEW.id::text,event_name);
  IF kind='TASK' THEN
    INSERT INTO agents(key,name,role) VALUES(j->>'agent_key',j->>'agent_key','agent') ON CONFLICT DO NOTHING;
    PERFORM add_work_edge(NEW.project_id,NEW.repository_id,'AGENT',j->>'agent_key','EXECUTED','TASK',NEW.id::text);
    PERFORM add_work_edge(NEW.project_id,NEW.repository_id,'TASK',NEW.id::text,'DEPENDS_ON','TASK',j->>'parent_task_id');
  ELSIF kind IN ('DECISION','ERROR','CHECKPOINT') THEN
    PERFORM add_work_edge(NEW.project_id,NEW.repository_id,'TASK',task::text,
      CASE kind WHEN 'DECISION' THEN 'CREATED' WHEN 'ERROR' THEN 'FOUND' ELSE 'FINISHED_AT' END,kind,NEW.id::text);
  ELSIF kind='SOLUTION' THEN
    PERFORM add_work_edge(NEW.project_id,NEW.repository_id,'ERROR',j->>'error_id','RESOLVED_BY','SOLUTION',NEW.id::text);
  END IF;
  IF kind='CHANGE' THEN
    IF COALESCE(j->'metadata'->>'source','agent')<>'git_snapshot' THEN
      PERFORM add_work_edge(NEW.project_id,NEW.repository_id,'TASK',task::text,'PRODUCED','COMMIT',j->>'commit_hash');
    END IF;
    FOR item IN SELECT value FROM jsonb_array_elements(j->'changed_files') LOOP
      PERFORM add_work_edge(NEW.project_id,NEW.repository_id,'TASK',task::text,'CHANGED','FILE',
        NEW.repository_id::text || ':' || (item->>'path'));
    END LOOP;
  END IF;
  IF kind IN ('DECISION','ERROR','SOLUTION','CHECKPOINT') AND jsonb_typeof(j->'metadata'->'files')='array' THEN
    FOR item IN SELECT value FROM jsonb_array_elements(j->'metadata'->'files') LOOP
      PERFORM add_work_edge(NEW.project_id,NEW.repository_id,kind,NEW.id::text,'AFFECTS','FILE',
        NEW.repository_id::text || ':' || (item#>>'{}'));
    END LOOP;
  END IF;
  IF kind='ERROR' AND j->>'solution' IS NOT NULL AND TG_OP='INSERT' THEN
    INSERT INTO solutions(project_id,repository_id,task_id,session_id,error_id,agent_key,solution)
      VALUES(NEW.project_id,NEW.repository_id,task,(j->>'session_id')::uuid,NEW.id,j->>'agent_key',j->>'solution');
  END IF;
  IF kind IN ('DECISION','ERROR','SOLUTION','CHECKPOINT','TASK') THEN
    body:=CASE kind WHEN 'DECISION' THEN j->>'decision' WHEN 'ERROR' THEN j->>'error_text'
      WHEN 'SOLUTION' THEN j->>'solution' ELSE j->>'summary' END;
    IF body IS NOT NULL THEN
      INSERT INTO memories(project_id,repository_id,task_id,session_id,agent_key,memory_type,title,content,source,metadata)
      VALUES(NEW.project_id,NEW.repository_id,task,(j->>'session_id')::uuid,j->>'agent_key',kind,j->>'title',
        body,'work_record',jsonb_build_object('entity_type',kind,'entity_id',NEW.id));
    END IF;
  END IF;
  RETURN NEW;
END $$;

-- Register existing records without inventing historical edges or timestamps.
DO $$ DECLARE mapping text[]; BEGIN
  FOREACH mapping SLICE 1 IN ARRAY ARRAY[['tasks','TASK'],['decisions','DECISION'],['errors','ERROR'],
    ['checkpoints','CHECKPOINT'],['sessions','SESSION'],['changes','CHANGE']] LOOP
    EXECUTE format('INSERT INTO work_entities SELECT project_id,%L,id::text FROM %I ON CONFLICT DO NOTHING',mapping[2],mapping[1]);
  END LOOP;
END $$;
DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['tasks','decisions','errors','solutions','checkpoints','changes','sessions'] LOOP
    EXECUTE format('CREATE TRIGGER capture_work AFTER INSERT OR UPDATE ON %I FOR EACH ROW EXECUTE FUNCTION capture_work()',t);
  END LOOP;
END $$;
