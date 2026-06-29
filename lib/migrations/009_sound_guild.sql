-- Sonidos y carpetas por servidor de Discord (multiservidor).
--  · guild_id = NULL  → TRANSVERSAL: visible en todos los servidores (lo que ya
--    existía sigue siendo transversal, sin tocar nada).
--  · guild_id = '<id>' → pertenece a ese servidor: visible solo en él (más, con
--    el toggle, los públicos de otros servidores).
-- Solo super admin / admin multiservidor pueden marcar un sonido transversal.
ALTER TABLE sounds  ADD COLUMN guild_id TEXT;
ALTER TABLE folders ADD COLUMN guild_id TEXT;
CREATE INDEX idx_sounds_guild  ON sounds(guild_id);
CREATE INDEX idx_folders_guild ON folders(guild_id);
