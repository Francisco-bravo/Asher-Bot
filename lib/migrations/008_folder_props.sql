-- Carpetas con dueño, color y visibilidad (permiso real).
--  · owner_user_id: quién creó la carpeta (NULL = global/heredada/admin).
--  · color: color de la carpeta (hex, NULL = por defecto). Lo ven todos.
--  · visibility: 'public' (todos) | 'private' (solo el dueño + admins). Una
--    carpeta privada oculta su subárbol completo (sonidos y subcarpetas) a los
--    demás; en una pública, cada sonido conserva su propia visibilidad.
ALTER TABLE folders ADD COLUMN owner_user_id INTEGER REFERENCES users(id);
ALTER TABLE folders ADD COLUMN color TEXT;
ALTER TABLE folders ADD COLUMN visibility TEXT NOT NULL DEFAULT 'public';
