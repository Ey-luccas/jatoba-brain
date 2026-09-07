CREATE TABLE audit_log (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  agent text,
  project_id uuid REFERENCES projects(id),
  repository_id uuid REFERENCES repositories(id),
  tool text NOT NULL,
  operation text NOT NULL,
  status text NOT NULL CHECK (status IN ('success','error')),
  duration_ms double precision NOT NULL,
  items_returned integer NOT NULL DEFAULT 0,
  metadata jsonb NOT NULL DEFAULT '{}'
);
CREATE INDEX ON audit_log(project_id,created_at);
CREATE INDEX ON audit_log(tool,created_at);
