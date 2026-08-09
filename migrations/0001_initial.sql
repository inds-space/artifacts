PRAGMA foreign_keys = ON;

CREATE TABLE artifact_types (
  name TEXT PRIMARY KEY,
  created_at TEXT NOT NULL
);

INSERT INTO artifact_types (name, created_at) VALUES
  ('plan', CURRENT_TIMESTAMP), ('presentation', CURRENT_TIMESTAMP),
  ('report', CURRENT_TIMESTAMP), ('spec', CURRENT_TIMESTAMP),
  ('diagram', CURRENT_TIMESTAMP), ('prototype', CURRENT_TIMESTAMP),
  ('code-review', CURRENT_TIMESTAMP), ('benchmark', CURRENT_TIMESTAMP),
  ('screenshot', CURRENT_TIMESTAMP), ('dataset', CURRENT_TIMESTAMP),
  ('handoff', CURRENT_TIMESTAMP), ('build-output', CURRENT_TIMESTAMP),
  ('receipt-log', CURRENT_TIMESTAMP);

CREATE TABLE artifacts (
  id TEXT PRIMARY KEY,
  agent TEXT NOT NULL CHECK (agent IN ('claude', 'codex', 'antigravity')),
  artifact_type TEXT NOT NULL REFERENCES artifact_types(name),
  slug TEXT NOT NULL,
  current_version INTEGER NOT NULL CHECK (current_version > 0),
  current_object_key TEXT NOT NULL,
  content_type TEXT NOT NULL,
  size_bytes INTEGER,
  sha256 TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'deleted')),
  deleted_at TEXT,
  delete_after TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (agent, artifact_type, slug)
);

CREATE TABLE artifact_versions (
  artifact_id TEXT NOT NULL REFERENCES artifacts(id) ON DELETE CASCADE,
  version INTEGER NOT NULL CHECK (version > 0),
  object_key TEXT NOT NULL UNIQUE,
  content_type TEXT NOT NULL,
  size_bytes INTEGER,
  sha256 TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (artifact_id, version)
);

CREATE INDEX idx_artifacts_active ON artifacts(status, agent, artifact_type, updated_at DESC);
CREATE INDEX idx_artifacts_delete_after ON artifacts(status, delete_after);
CREATE INDEX idx_versions_retention ON artifact_versions(artifact_id, version DESC, created_at DESC);
