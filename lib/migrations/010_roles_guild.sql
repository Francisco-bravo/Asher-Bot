-- Roles por servidor + super administrador (multiservidor).
--  · user_roles.guild_id = NULL  → rol GLOBAL: vale en todos los servidores.
--  · user_roles.guild_id = '<id>' → rol solo en ese servidor.
-- Lo existente queda como rol global (guild_id NULL) → nadie pierde acceso.
-- SQLite no permite ALTER de la PK, así que se recrea la tabla.
CREATE TABLE user_roles_new (
  user_id  INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role_id  INTEGER NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
  guild_id TEXT   -- NULL = global
);
INSERT INTO user_roles_new (user_id, role_id, guild_id)
  SELECT user_id, role_id, NULL FROM user_roles;
DROP TABLE user_roles;
ALTER TABLE user_roles_new RENAME TO user_roles;
-- Unicidad tratando NULL como '' (evita duplicar el mismo rol global/por-guild).
CREATE UNIQUE INDEX idx_user_roles_uniq ON user_roles(user_id, role_id, IFNULL(guild_id, ''));
CREATE INDEX idx_user_roles_user ON user_roles(user_id);

-- Super administrador global: puede dar/quitar admin en uno, varios o todos los
-- servidores. Los admin actuales pasan a super para no perder el control que ya
-- tenían (pueden luego degradar a otros a admin por-servidor).
ALTER TABLE users ADD COLUMN is_super INTEGER NOT NULL DEFAULT 0;
UPDATE users SET is_super = 1 WHERE id IN (
  SELECT ur.user_id FROM user_roles ur JOIN roles r ON r.id = ur.role_id WHERE r.name = 'admin'
);
