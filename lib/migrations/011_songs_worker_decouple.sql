-- La tabla songs se muda al worker (catálogo compartido entre entornos). Los
-- ids que van a usarse de ahora en más los emite el worker, y NO van a existir
-- como fila en la songs LOCAL -- las FK locales a songs(id) romperían
-- (PRAGMA foreign_keys = ON) apenas se intente insertar/cachear algo nuevo.
-- Se recrean playlist_items y local_cache sin esa FK. De paso, playlist_items
-- pasa a guardar título/artista/duración/url directo (denormalizado) para no
-- depender de un JOIN a songs al listar una playlist.

CREATE TABLE playlist_items_new (
  id          INTEGER PRIMARY KEY,
  playlist_id INTEGER NOT NULL REFERENCES playlists(id) ON DELETE CASCADE,
  song_id     INTEGER NOT NULL,
  title       TEXT,
  artist      TEXT,
  duration_ms INTEGER,
  source_url  TEXT,
  position    INTEGER NOT NULL,
  added_at    INTEGER NOT NULL
);
INSERT INTO playlist_items_new (id, playlist_id, song_id, title, artist, duration_ms, source_url, position, added_at)
  SELECT pi.id, pi.playlist_id, pi.song_id, s.title, s.artist, s.duration_ms, s.source_url, pi.position, pi.added_at
  FROM playlist_items pi LEFT JOIN songs s ON s.id = pi.song_id;
DROP TABLE playlist_items;
ALTER TABLE playlist_items_new RENAME TO playlist_items;
CREATE INDEX idx_playlist_items ON playlist_items(playlist_id, position);

CREATE TABLE local_cache_new (
  song_id        INTEGER PRIMARY KEY,
  path           TEXT NOT NULL,
  size_bytes     INTEGER NOT NULL,
  last_access_at INTEGER NOT NULL
);
INSERT INTO local_cache_new (song_id, path, size_bytes, last_access_at)
  SELECT song_id, path, size_bytes, last_access_at FROM local_cache;
DROP TABLE local_cache;
ALTER TABLE local_cache_new RENAME TO local_cache;
