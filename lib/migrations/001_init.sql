-- Esquema inicial de la capa de almacenamiento + usuarios/roles/playlists.

-- Usuarios y roles ---------------------------------------------------------
CREATE TABLE users (
  id            INTEGER PRIMARY KEY,
  discord_id    TEXT UNIQUE,           -- login vía OAuth Discord (prod)
  username      TEXT NOT NULL,
  display_name  TEXT,
  avatar_url    TEXT,
  created_at    INTEGER NOT NULL,
  last_login_at INTEGER
);

CREATE TABLE roles (
  id          INTEGER PRIMARY KEY,
  name        TEXT UNIQUE NOT NULL,    -- admin, dj, user, guest
  description TEXT
);

CREATE TABLE user_roles (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role_id INTEGER NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
  PRIMARY KEY (user_id, role_id)
);

CREATE TABLE sessions (
  token      TEXT PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);

-- Sonidos ------------------------------------------------------------------
CREATE TABLE sounds (
  id            INTEGER PRIMARY KEY,
  owner_user_id INTEGER REFERENCES users(id),   -- NULL = global/built-in
  label         TEXT NOT NULL,
  folder        TEXT NOT NULL DEFAULT '',
  object_key    TEXT NOT NULL,
  ext           TEXT NOT NULL,
  size_bytes    INTEGER,
  duration_ms   INTEGER,
  visibility    TEXT NOT NULL DEFAULT 'global',  -- global | private | shared
  created_at    INTEGER NOT NULL
);
CREATE INDEX idx_sounds_owner ON sounds(owner_user_id);

-- Visibilidad y límite de uso por rol (ocultar botón o ponerle tope) -------
CREATE TABLE sound_role_policy (
  sound_id      INTEGER NOT NULL REFERENCES sounds(id) ON DELETE CASCADE,
  role_id       INTEGER NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
  visible       INTEGER NOT NULL DEFAULT 1,  -- 0 = oculto para ese rol
  rate_limit    INTEGER,                     -- máx reproducciones por ventana (NULL = sin tope)
  rate_window_s INTEGER,                     -- ventana en segundos
  PRIMARY KEY (sound_id, role_id)
);

-- Música (metadatos + estado de caché) -------------------------------------
CREATE TABLE songs (
  id             INTEGER PRIMARY KEY,
  source_url     TEXT UNIQUE NOT NULL,   -- URL/ID normalizado (dedupe)
  title          TEXT,
  artist         TEXT,
  album          TEXT,
  duration_ms    INTEGER,
  art_key        TEXT,                   -- art/{id}.jpg (NULL si no hay)
  audio_key      TEXT,                   -- music/{id}.{ext} (NULL = no persistido)
  ext            TEXT,
  play_count     INTEGER NOT NULL DEFAULT 0,
  persisted      INTEGER NOT NULL DEFAULT 0,  -- 1 = guardada en object-store
  last_played_at INTEGER,
  created_at     INTEGER NOT NULL
);

-- Caché local LRU (solo música; los sonidos viven siempre en disco) --------
CREATE TABLE local_cache (
  song_id        INTEGER PRIMARY KEY REFERENCES songs(id) ON DELETE CASCADE,
  path           TEXT NOT NULL,
  size_bytes     INTEGER NOT NULL,
  last_access_at INTEGER NOT NULL
);

-- Historial de reproducciones ----------------------------------------------
CREATE TABLE play_history (
  id        INTEGER PRIMARY KEY,
  user_id   INTEGER REFERENCES users(id),
  kind      TEXT NOT NULL,    -- 'sound' | 'song'
  ref_id    INTEGER NOT NULL,
  guild_id  TEXT,
  played_at INTEGER NOT NULL
);
CREATE INDEX idx_history_recent ON play_history(played_at DESC);
CREATE INDEX idx_history_rate   ON play_history(user_id, kind, ref_id, played_at);

-- Listas de reproducción ----------------------------------------------------
CREATE TABLE playlists (
  id            INTEGER PRIMARY KEY,
  owner_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name          TEXT NOT NULL,
  visibility    TEXT NOT NULL DEFAULT 'private',
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);

CREATE TABLE playlist_items (
  id          INTEGER PRIMARY KEY,
  playlist_id INTEGER NOT NULL REFERENCES playlists(id) ON DELETE CASCADE,
  song_id     INTEGER NOT NULL REFERENCES songs(id),
  position    INTEGER NOT NULL,
  added_at    INTEGER NOT NULL
);
CREATE INDEX idx_playlist_items ON playlist_items(playlist_id, position);
