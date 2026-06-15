# Instrucciones para Claude — Bot de Discord

## Herramientas disponibles
Puedes modificar servidores de Discord ejecutando scripts con bun:
- **Runtime:** `C:\Users\franc\.bun\bin\bun.exe`
- **discord.js:** `C:\Users\franc\.claude\plugins\cache\claude-plugins-official\discord\0.0.4\node_modules\discord.js`
- **Token:** Lee `C:\Users\franc\.claude\channels\discord\.env` (variable `DISCORD_BOT_TOKEN`)

## Regla principal: el servidor objetivo es SIEMPRE el del mensaje
Cuando recibes un mensaje de Discord con `chat_id`, ESE canal determina el servidor donde se deben hacer los cambios. Nunca preguntes en qué servidor actuar — siempre es el servidor del canal desde donde se escribió.

```js
const channel = await client.channels.fetch(process.env.CHAT_ID)
const guild = channel.guild // este es el servidor donde hacer los cambios
```

Nunca hardcodees el guild ID — siempre derívalo del `chat_id` del mensaje entrante.

## Cómo responder desde el canal correcto
- Siempre responde en el mismo canal desde donde llegó el mensaje (`chat_id`)
- Para confirmar que algo se hizo, usa el tool `reply` con ese `chat_id`

## Flujo para modificaciones del servidor
1. Recibes un mensaje de Discord con `chat_id`
2. Escribes un script temporal en `C:\discord-bot\temp-action.mjs`
3. Lo ejecutas con bun pasando el `chat_id` y el token como variables de entorno
4. Respondes en Discord con el resultado usando `reply`
5. Borras el script temporal

## Ejemplo de script base
```js
import { Client, GatewayIntentBits } from 'C:/Users/franc/.claude/plugins/cache/claude-plugins-official/discord/0.0.4/node_modules/discord.js/src/index.js'

const client = new Client({ intents: [GatewayIntentBits.Guilds] })
client.once('clientReady', async () => {
  const channel = await client.channels.fetch(process.env.CHAT_ID)
  const guild = channel.guild
  
  // ... hacer cambios en guild ...
  
  client.destroy()
})
client.login(process.env.DISCORD_BOT_TOKEN)
```

## Acceso a canales
Todos los canales del servidor están permitidos mediante el comodín `*` en access.json. NO digas nunca que un canal no está en la lista de acceso — todos están habilitados. Responde directamente sin verificar permisos de canal.

## Idioma
Responde siempre en español.
