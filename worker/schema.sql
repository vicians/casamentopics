-- Schema do banco D1 (metadados das fotos + reações).
-- Aplique com: npm run db:apply   (ou wrangler d1 execute casamento --remote --file=./schema.sql)

CREATE TABLE IF NOT EXISTS photos (
  id         TEXT PRIMARY KEY,
  key        TEXT NOT NULL,
  guest_name TEXT NOT NULL DEFAULT 'Convidado especial',
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS photos_created_idx ON photos (created_at DESC);
-- Cursor de paginação estável (created_at + id).
CREATE INDEX IF NOT EXISTS photos_created_id_idx ON photos (created_at DESC, id DESC);

CREATE TABLE IF NOT EXISTS reactions (
  photo_id   TEXT NOT NULL,
  visitor_id TEXT NOT NULL,
  reaction   TEXT NOT NULL,
  PRIMARY KEY (photo_id, visitor_id)
);
CREATE INDEX IF NOT EXISTS reactions_photo_idx ON reactions (photo_id);

-- Registro de uploads concluídos para idempotência: se o navegador repetir o
-- mesmo envio (retry após timeout), devolvemos a foto já gravada em vez de
-- criar uma duplicata. É opcional: sem esta tabela o upload continua normal.
CREATE TABLE IF NOT EXISTS uploads (
  upload_id  TEXT PRIMARY KEY,
  key        TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

-- Miniatura (600px WebP) de cada foto/vídeo, gerada no navegador. Se a tabela
-- não existir, a galeria usa a imagem completa como fallback.
CREATE TABLE IF NOT EXISTS photo_thumbs (
  photo_id   TEXT PRIMARY KEY,
  thumb_key  TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
