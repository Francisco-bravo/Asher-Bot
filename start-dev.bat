@echo off
title AsherDev - Bot de Musica (DEV / rama dev)
cd /d C:\discord-bot

rem Levanta la web (login/uploads/playlists/historial) en otra ventana
start "AsherDev - Web (8770)" cmd /k node --env-file=.env web.mjs

rem Bot integrado (panel + control en 8765) en esta ventana
node --env-file=.env bot.mjs
pause
