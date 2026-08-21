CREATE TABLE artifacts_new (
  id TEXT PRIMARY KEY,
  agent TEXT NOT NULL,
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

CREATE TABLE artifact_versions_new (
  artifact_id TEXT NOT NULL REFERENCES artifacts_new(id) ON DELETE CASCADE,
  version INTEGER NOT NULL CHECK (version > 0),
  object_key TEXT NOT NULL UNIQUE,
  content_type TEXT NOT NULL,
  size_bytes INTEGER,
  sha256 TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (artifact_id, version)
);

INSERT INTO artifacts_new SELECT * FROM artifacts;
INSERT INTO artifact_versions_new SELECT * FROM artifact_versions;

DROP TABLE artifact_versions;
DROP TABLE artifacts;

ALTER TABLE artifacts_new RENAME TO artifacts;
ALTER TABLE artifact_versions_new RENAME TO artifact_versions;

CREATE INDEX idx_artifacts_active ON artifacts(status, agent, artifact_type, updated_at DESC);
CREATE INDEX idx_artifacts_delete_after ON artifacts(status, delete_after);
CREATE INDEX idx_versions_retention ON artifact_versions(artifact_id, version DESC, created_at DESC);
