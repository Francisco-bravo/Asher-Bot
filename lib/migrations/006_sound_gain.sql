-- Normalización de volumen por sonido (loudness EBU R128).
-- gain_db: ganancia medida automáticamente para llevar el sonido al objetivo
--          común (~-16 LUFS). NULL = aún no analizado.
-- gain_offset_db: ajuste manual del admin, se SUMA a gain_db al reproducir.
-- No se toca el archivo: la ganancia se aplica en vivo al decodificar.
ALTER TABLE sounds ADD COLUMN gain_db REAL;
ALTER TABLE sounds ADD COLUMN gain_offset_db REAL NOT NULL DEFAULT 0;
