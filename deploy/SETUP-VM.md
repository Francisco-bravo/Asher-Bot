# Preparación de una VM (Fase 3) — una sola vez por servidor

El despliegue automático (workflows) copia los archivos y reinicia los servicios,
pero la **primera vez** cada VM necesita esta preparación manual.

> Rutas según la VM: el deploy deja los archivos en
> `~/` (VM **test** 144.22.62.84) y en `~/music-bot/` (VM **prod** 146.181.44.27).
> Ajusta los `cd` y el `WorkingDirectory` del service en consecuencia.

## 1. Verificar Node

```bash
node -v
```

- **≥ 22.5** → `node:sqlite` funciona (es lo que usa `lib/db.mjs`).
- **< 22.5** → cambiar `lib/db.mjs` a `better-sqlite3` (misma API síncrona):
  `npm i better-sqlite3` y reemplazar el import. Es el único archivo afectado.

## 2. Variables de entorno (añadir al `.env` de la VM)

```env
# OAuth — crear/registrar el redirect URI de ESTA VM en el portal de Discord
DISCORD_CLIENT_ID=...
DISCORD_CLIENT_SECRET=...
DISCORD_REDIRECT_URI=http://<IP-o-dominio-de-la-VM>:8770/auth/callback
WEB_PORT=8770
SESSION_SECRET=<aleatorio largo>
# Almacenamiento: 'local' en test; 's3' (R2/Oracle) en prod cuando esté listo
STORAGE_BACKEND=local
```

Registra `DISCORD_REDIRECT_URI` en https://discord.com/developers/applications
(OAuth2 → Redirects), debe coincidir carácter por carácter.

## 3. Servicio systemd para la web

```bash
sudo cp deploy/music-web.service /etc/systemd/system/music-web.service
sudo nano /etc/systemd/system/music-web.service   # ajustar WorkingDirectory
sudo systemctl daemon-reload
sudo systemctl enable --now music-web
```

## 4. Ingesta inicial de sonidos

Las **migraciones corren solas** al arrancar el bot/web (`getDb()`). La ingesta de
los sonidos que ya están en la VM es manual y única (idempotente):

```bash
cd ~            # o ~/music-bot en prod
node scripts/ingest-sounds.mjs    # usa ./sounds por defecto
```

## 5. Red

Si el panel web se accede desde fuera, abrir el puerto **8770** en el firewall del
SO y en la *security list* de Oracle (igual que ya se hizo con el 8765).

## 6. Comprobar

```bash
systemctl status music-bot music-web --no-pager
journalctl -u music-web -n 20 --no-pager
```
