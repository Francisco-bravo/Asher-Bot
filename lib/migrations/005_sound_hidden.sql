-- Ocultar global (admin): a diferencia de user_sound_prefs.hidden (por usuario),
-- esta bandera oculta el sonido para TODOS. Es un "soft delete": el sonido deja
-- de aparecer en el soundboard pero sigue en la base; desde Gestión se ve en gris
-- y puede restaurarse o eliminarse de forma permanente.
ALTER TABLE sounds ADD COLUMN hidden INTEGER NOT NULL DEFAULT 0;
