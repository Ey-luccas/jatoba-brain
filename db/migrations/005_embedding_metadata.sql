ALTER TABLE memories ADD COLUMN IF NOT EXISTS embedding_provider text;
ALTER TABLE memories ADD COLUMN IF NOT EXISTS embedding_model text;
ALTER TABLE memories ADD COLUMN IF NOT EXISTS embedding_dimension integer;
ALTER TABLE memories ADD COLUMN IF NOT EXISTS embedding_version text;

CREATE INDEX IF NOT EXISTS idx_memories_embedding_contract
  ON memories(project_id, embedding_provider, embedding_model, embedding_dimension);
