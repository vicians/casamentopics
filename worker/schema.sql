-- Schema do banco D1 (metadados das fotos + reações).
-- Aplique com: npm run db:apply   (ou wrangler d1 execute casamento --remote --file=./schema.sql)

CREATE TABLE IF NOT EXISTS photos (
  id         TEXT PRIMARY KEY,
  key        TEXT NOT NULL,
  guest_name TEXT NOT NULL DEFAULT 'Convidado especial',
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS photos_created_idx ON photos (created_at DESC);

CREATE TABLE IF NOT EXISTS reactions (
  photo_id   TEXT NOT NULL,
  visitor_id TEXT NOT NULL,
  reaction   TEXT NOT NULL,
  PRIMARY KEY (photo_id, visitor_id)
);
CREATE INDEX IF NOT EXISTS reactions_photo_idx ON reactions (photo_id);
