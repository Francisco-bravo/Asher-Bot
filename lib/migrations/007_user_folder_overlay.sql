-- Overlay por-usuario para organizar el soundboard SIN afectar a los demás:
--  · user_sound_prefs.folder: carpeta personal de un sonido (mover solo para mí).
--    NULL = sin override (usa sounds.folder, la carpeta real/global).
--  · user_folder_prefs: nombre personal de una carpeta (renombrar solo para mí).
--    La clave es la RUTA real de la carpeta; alias cambia solo el nombre mostrado.
-- Los admin siguen moviendo/renombrando de forma global (sounds.folder / folders).
ALTER TABLE user_sound_prefs ADD COLUMN folder TEXT;

CREATE TABLE user_folder_prefs (
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  path       TEXT NOT NULL,            -- ruta REAL de la carpeta (clave estable)
  alias      TEXT NOT NULL,            -- nombre personal del último segmento
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, path)
);
