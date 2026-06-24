-- Carpetas del soundboard persistidas. Antes las carpetas solo existían si algún
-- sonido tenía esa ruta en `folder`; ahora se pueden crear de forma explícita
-- (incluidas carpetas vacías y anidadas) y elegirlas al subir un sonido.
CREATE TABLE folders (
  id         INTEGER PRIMARY KEY,
  path       TEXT NOT NULL UNIQUE,   -- ruta completa separada por '/', ej: "memes/risas"
  created_at INTEGER NOT NULL
);
