-- Canciones "permanentes": fijadas en caché local, nunca evictadas.
-- Las subidas por el usuario nacen permanentes (persisted=1 + permanent=1).
ALTER TABLE songs ADD COLUMN permanent INTEGER NOT NULL DEFAULT 0;
