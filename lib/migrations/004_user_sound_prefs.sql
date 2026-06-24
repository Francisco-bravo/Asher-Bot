-- Personalización del soundboard por usuario (overlay; no toca la tabla sounds).
-- Cada fila guarda, para un usuario y un sonido, su nombre propio (alias) y/o si
-- lo ocultó para sí mismo. El alias solo lo ve quien lo editó; ocultar solo le
-- afecta a él (el sonido sigue para los demás).
CREATE TABLE user_sound_prefs (
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  sound_id   INTEGER NOT NULL REFERENCES sounds(id) ON DELETE CASCADE,
  alias      TEXT,                        -- nombre personalizado (NULL = usa el original)
  hidden     INTEGER NOT NULL DEFAULT 0,  -- 1 = el usuario lo ocultó para sí mismo
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, sound_id)
);
CREATE INDEX idx_sound_prefs_sound ON user_sound_prefs(sound_id);
