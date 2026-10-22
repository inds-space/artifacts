ALTER TABLE artifacts ADD COLUMN visibility TEXT NOT NULL DEFAULT 'private' CHECK (visibility IN ('private', 'public'));
